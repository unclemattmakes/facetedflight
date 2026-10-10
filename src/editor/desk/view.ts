// src/editor/desk/view.ts — the draft, drawn in the world. DEV-469.
//
// What the desk draws over the island:
//
//  · the line: the course's spline, sampled as the format samples it
//    (`playerCourseSpline`), so the drawn curve IS the curve the rings are
//    spaced along;
//  · a handle per control point, the selected one lit;
//  · the finish, where `finish.t` puts it (the start is a PAD since DEV-475,
//    drawn by `start-pad.ts`);
//  · the RINGS, through the game's own path: `game/rings.ts`'s `loadRings`,
//    handed the EXPANDED level (`evaluateDraft`'s). One ring renderer in the
//    game, not two — the gate you place is the gate you fly, frame, studs,
//    finish and all;
//  · a small marker where a skipped ring would stand, so it can be put back;
//  · the warnings, each at its own place (EDITOR.md §5.3: *"Warnings appear in
//    the world, not in a list"*), coloured by severity;
//  · DEV-474: ships flown along the expanded level's race line (`flyby.ts`).
//  · DEV-478: what is IN THE GROUND, in red where it is (`ground-marks.ts`):
//    a buried ring's opening as a loop, the stretch of line under the rock.
//  · DEV-486: the RUN-IN, the straight from the ship on its pad to the line's
//    first point (`runInOf`, the expansion's own first leg of `Level.route`),
//    fainter than the line: the racers fly it, and it is judged with it.
//
// Everything but the rings is drawn THROUGH the ground (no depth test) and at
// a constant size on screen: this is a tool's overlay, and a handle hidden
// behind a hill is a handle you cannot pick. The rings keep the game's own
// materials and depth, because what they show is the course as it will fly.
//
// Materials: `MeshBasicMaterial` and `LineBasicMaterial` only, with no
// `onBeforeCompile` — three's own programs, nothing patched. The rings compile
// the game's ring programs. `editor-desk.spec.ts` asks GL for LINK_STATUS on
// every program the editor leaves behind (CLAUDE.md: no gate compiles a
// shader).

import * as THREE from 'three'
import type { CourseSpline } from '@/content/course-spline'
import { splinePointAt } from '@/content/course-spline'
import type { Level } from '@/content/level-schema'
import type { PlayerCourse } from '@/content/player-course'
import type { EditorWarning } from '@/editor/core'
import { type LoadedRings, loadRings } from '@/game/rings'
import { createFlyby, loadFlybyShip } from './flyby'
import type { GroundMarks } from './ground-marks'
import { DESK_POLICY } from './policy'

/** Draw order for the overlay: after the world, so nothing the world draws covers it. */
const OVERLAY_ORDER = 1000

const overlay = (color: number, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: opacity < 1,
    opacity,
    fog: false,
  })

const COLOURS = {
  line: 0xffffff,
  handle: 0xe8f4ff,
  selected: 0xffc233,
  finish: 0xffffff,
  skipped: 0x8a8f98,
  error: 0xff3b3b,
  warning: 0xffa726,
  note: 0x5ab4ff,
  /** DEV-501: the anchored point: the start pad's own green, so it reads as the pad's. */
  anchored: 0x33e07a,
} as const

/** DEV-478 and DEV-503: the red geometry as drawn, each list's points in the world. */
export interface DrawnMarks {
  rings: [number, number, number][][]
  under: [number, number, number][][]
  propRings: [number, number, number][][]
  propLine: [number, number, number][][]
}

export interface DeskView {
  readonly root: THREE.Group
  /** Redraw the line, the handles and the markers for `course` (and its spline, if it has one). */
  setCourse(course: PlayerCourse, spline: CourseSpline | null, selection: number | null): void
  /** Redraw the warning markers. */
  setWarnings(warnings: readonly EditorWarning[]): void
  /** DEV-478: redraw the red loops round buried rings and the red stretches under the ground. */
  setGroundMarks(marks: GroundMarks): void
  /** DEV-478: the red geometry as drawn, world space: each loop's and each stretch's points. */
  groundMarks(): DrawnMarks
  /** Rebuild the rings from an expanded level (or clear them with null). Async; the latest wins. */
  setLevel(level: Level | null): void
  /** Each frame: keep the handles and markers a constant size on screen. */
  update(camera: THREE.Camera): void
  /** The drawn rings, for the spec's geometry check. */
  rings(): LoadedRings | null
  /** The drawn line's samples. */
  lineSamples(): [number, number, number][]
  /** DEV-486: draw the run-in from `from` to `to`, or none. */
  setRunIn(from: readonly number[] | null, to: readonly number[] | null): void
  /** DEV-486: the run-in as drawn, read off its buffer: its two ends, or null. */
  runIn(): [number, number, number][] | null
  dispose(): void
}

export const createDeskView = (): DeskView => {
  const root = new THREE.Group()
  root.name = 'editor'

  // ── the line ──────────────────────────────────────────────────────────
  const lineGeometry = new THREE.BufferGeometry()
  const lineMaterial = new THREE.LineBasicMaterial({
    color: COLOURS.line,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.85,
    fog: false,
  })
  const line = new THREE.Line(lineGeometry, lineMaterial)
  line.name = 'editor-line'
  line.renderOrder = OVERLAY_ORDER
  line.frustumCulled = false
  root.add(line)
  let samples: [number, number, number][] = []

  // ── DEV-486: the run-in, fainter than the line ───────────────────────
  const runInMaterial = new THREE.LineBasicMaterial({
    color: COLOURS.line,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.45,
    fog: false,
  })
  const runInLine = new THREE.Line(new THREE.BufferGeometry(), runInMaterial)
  runInLine.name = 'editor-run-in'
  runInLine.renderOrder = OVERLAY_ORDER
  runInLine.frustumCulled = false
  runInLine.visible = false
  root.add(runInLine)

  // ── handles and markers: one shape, many materials ────────────────────
  const shape = new THREE.OctahedronGeometry(1, 0)
  const ball = new THREE.SphereGeometry(1, 16, 12)
  const materials = {
    handle: overlay(COLOURS.handle),
    selected: overlay(COLOURS.selected),
    finish: overlay(COLOURS.finish),
    skipped: overlay(COLOURS.skipped, 0.8),
    error: overlay(COLOURS.error),
    warning: overlay(COLOURS.warning),
    note: overlay(COLOURS.note),
    anchored: overlay(COLOURS.anchored),
  }
  const handles = new THREE.Group()
  handles.name = 'editor-handles'
  const markers = new THREE.Group()
  markers.name = 'editor-markers'
  const warningMarks = new THREE.Group()
  warningMarks.name = 'editor-warnings'
  root.add(handles, markers, warningMarks)

  // ── DEV-478: in the ground, in red ────────────────────────────────────
  // Line segments, drawn through the ground like the rest of the overlay (a
  // stretch inside a hill is exactly what must be seen), after the line so
  // the red lies over the white where they share a place.
  const groundMaterial = new THREE.LineBasicMaterial({
    color: COLOURS.error,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  // DEV-503: the prop marks draw OVER the line, which is transparent and so
  // sorts after every opaque overlay whatever its order: in the open air (a
  // spire, not a hill) the red and the white stand in the same pixels, and
  // an opaque red would be painted out. Transparent at full opacity, it joins
  // the line's pass, where `renderOrder` puts it on top.
  const propMaterial = new THREE.LineBasicMaterial({
    color: COLOURS.error,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1,
    fog: false,
  })
  const segmentsOf = (
    name: string,
    material: THREE.Material = groundMaterial,
  ): THREE.LineSegments => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry(), material)
    l.name = name
    l.renderOrder = OVERLAY_ORDER + 2
    l.frustumCulled = false
    root.add(l)
    return l
  }
  const buriedRings = segmentsOf('editor-buried-rings')
  const underLine = segmentsOf('editor-under-line')
  // DEV-503: a ring a prop reaches into, and a stretch of line near one.
  const propRingLoops = segmentsOf('editor-prop-rings', propMaterial)
  const propLineRuns = segmentsOf('editor-prop-line', propMaterial)
  let drawnMarks: DrawnMarks = { rings: [], under: [], propRings: [], propLine: [] }
  /** Pairs of points, one segment each: closed loops, or open runs. */
  const setSegments = (
    target: THREE.LineSegments,
    lists: readonly (readonly (readonly number[])[])[],
    closed: boolean,
  ): void => {
    const flat: number[] = []
    for (const list of lists) {
      const n = list.length
      const last = closed ? n : n - 1
      for (let k = 0; k < last; k++) {
        const a = list[k] as readonly number[]
        const b = list[(k + 1) % n] as readonly number[]
        flat.push(a[0] as number, a[1] as number, a[2] as number)
        flat.push(b[0] as number, b[1] as number, b[2] as number)
      }
    }
    target.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3))
    target.geometry.setDrawRange(0, flat.length / 3)
    target.visible = flat.length > 0
  }

  /** Scale relative to the handle's (a marker a little bigger, a skipped ring a little smaller). */
  const sized = new WeakMap<THREE.Object3D, number>()
  const mark = (
    group: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    at: readonly number[],
    relative: number,
    name: string,
  ): void => {
    const m = new THREE.Mesh(geometry, material)
    m.name = name
    m.position.set(at[0] as number, at[1] as number, at[2] as number)
    m.renderOrder = OVERLAY_ORDER + 1
    m.frustumCulled = false
    sized.set(m, relative)
    group.add(m)
  }
  const clear = (group: THREE.Group): void => {
    // The geometries and materials are shared and owned here; only the meshes go.
    group.clear()
  }

  // ── the rings, through the game's path ───────────────────────────────
  let rings: LoadedRings | null = null
  let ringsGeneration = 0
  const dropRings = (): void => {
    if (!rings) return
    rings.object.removeFromParent()
    rings.dispose()
    rings = null
  }

  // ── DEV-474: the fly-by ───────────────────────────────────────────────
  //
  // Ships along the expanded level's `route`, set with the rings (the same
  // debounced level) and moved each frame by the wall clock. The hull loads
  // once; a desk without it draws the line and rings as before.
  const flyby = createFlyby()
  root.add(flyby.object)
  void loadFlybyShip().then(
    (ship) => flyby.setPrototype(ship),
    (err: unknown) => console.warn('editor: the fly-by ship did not load', err),
  )
  let flybyLast = -1
  const flybyStep = (): number => {
    const now = performance.now()
    const seconds = flybyLast < 0 ? 0 : (now - flybyLast) / 1000
    flybyLast = now
    return seconds
  }

  const _p = new THREE.Vector3()
  const _eye = new THREE.Vector3()

  return {
    root,
    setCourse(course, spline, selection) {
      // The line.
      samples = spline ? spline.samples.map((s) => [s.x, s.y, s.z]) : []
      const flat = new Float32Array(samples.length * 3)
      samples.forEach((s, i) => {
        flat.set(s, i * 3)
      })
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(flat, 3))
      lineGeometry.setDrawRange(0, samples.length)
      lineGeometry.computeBoundingSphere()
      // The handles.
      clear(handles)
      course.path.points.forEach((p, i) => {
        // DEV-501: the anchored point is drawn LOCKED — the pad's green, and a
        // diamond rather than a ball — because it is the pad's and no drag
        // moves it (a click on it picks the pad).
        if (i === 0 && course.path.anchor) {
          mark(handles, shape, materials.anchored, p, 1.2, `editor-point-${i}`)
          ;(handles.children.at(-1) as THREE.Object3D).userData.anchored = true
          return
        }
        mark(
          handles,
          ball,
          i === selection ? materials.selected : materials.handle,
          p,
          i === selection ? 1.3 : 1,
          `editor-point-${i}`,
        )
      })
      // The finish, and the skipped rings.
      clear(markers)
      if (spline && spline.length > 0) {
        const L = spline.length
        const at = (t: number): number[] => {
          const q = splinePointAt(spline, t * L)
          return [q.x, q.y, q.z]
        }
        mark(markers, shape, materials.finish, at(course.finish.t), 1.6, 'editor-finish')
        for (const r of course.rings) {
          if (r.skip) mark(markers, shape, materials.skipped, at(r.t), 0.9, 'editor-skipped')
        }
      }
    },
    setRunIn(from, to) {
      if (!from || !to) {
        runInLine.visible = false
        return
      }
      const flat = new Float32Array([
        from[0] as number,
        from[1] as number,
        from[2] as number,
        to[0] as number,
        to[1] as number,
        to[2] as number,
      ])
      runInLine.geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3))
      runInLine.geometry.setDrawRange(0, 2)
      runInLine.visible = true
    },
    runIn() {
      if (!runInLine.visible) return null
      const a = runInLine.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
      if (!a) return null
      return [
        [a.getX(0), a.getY(0), a.getZ(0)],
        [a.getX(1), a.getY(1), a.getZ(1)],
      ]
    },
    setWarnings(warnings) {
      clear(warningMarks)
      for (const w of warnings) {
        if (!w.at) continue
        const material =
          w.severity === 'error'
            ? materials.error
            : w.severity === 'warning'
              ? materials.warning
              : materials.note
        mark(warningMarks, shape, material, w.at, 1.2, `editor-warning-${w.kind}`)
        // DEV-503: and a marker on every prop it is about.
        for (const p of w.props ?? [])
          mark(warningMarks, shape, material, p, 1.6, 'editor-prop-marker')
      }
    },
    setGroundMarks(marks) {
      const copy = (list: readonly (readonly number[])[]): [number, number, number][] =>
        list.map((p) => [p[0] as number, p[1] as number, p[2] as number])
      drawnMarks = {
        rings: marks.rings.map((r) => copy(r.rim)),
        under: marks.under.map(copy),
        propRings: marks.propRings.map((r) => copy(r.rim)),
        propLine: marks.propLine.map(copy),
      }
      setSegments(buriedRings, drawnMarks.rings, true)
      setSegments(underLine, drawnMarks.under, false)
      setSegments(propRingLoops, drawnMarks.propRings, true)
      setSegments(propLineRuns, drawnMarks.propLine, false)
    },
    groundMarks: () => {
      // Read back off the drawn buffers, not off the copy handed in.
      const read = (l: THREE.LineSegments, sizes: number[], closed: boolean) => {
        const a = l.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
        const out: [number, number, number][][] = []
        let at = 0
        for (const n of sizes) {
          const pts: [number, number, number][] = []
          const segs = closed ? n : n - 1
          for (let k = 0; k < segs; k++) {
            const i = (at + k) * 2
            if (a) pts.push([a.getX(i), a.getY(i), a.getZ(i)])
          }
          if (!closed && a && segs > 0) {
            const i = (at + segs - 1) * 2 + 1
            pts.push([a.getX(i), a.getY(i), a.getZ(i)])
          }
          at += segs
          out.push(pts)
        }
        return out
      }
      return {
        rings: read(
          buriedRings,
          drawnMarks.rings.map((r) => r.length),
          true,
        ),
        under: read(
          underLine,
          drawnMarks.under.filter((u) => u.length > 1).map((u) => u.length),
          false,
        ),
        propRings: read(
          propRingLoops,
          drawnMarks.propRings.map((r) => r.length),
          true,
        ),
        propLine: read(
          propLineRuns,
          drawnMarks.propLine.filter((u) => u.length > 1).map((u) => u.length),
          false,
        ),
      }
    },
    setLevel(level) {
      const generation = ++ringsGeneration
      flyby.setRoute(level?.route) // DEV-474
      if (!level) {
        dropRings()
        return
      }
      void loadRings(level).then(
        (loaded) => {
          if (generation !== ringsGeneration) {
            loaded.dispose()
            return
          }
          dropRings()
          rings = loaded
          loaded.object.name = 'editor-rings'
          root.add(loaded.object)
        },
        (err: unknown) => {
          console.warn('editor: the rings did not build', err)
        },
      )
    },
    update(camera) {
      flyby.update(flybyStep(), camera) // DEV-474
      camera.getWorldPosition(_eye)
      for (const group of [handles, markers, warningMarks]) {
        for (const m of group.children) {
          const d = m.getWorldPosition(_p).distanceTo(_eye)
          m.scale.setScalar(d * DESK_POLICY.handleScreenFraction * (sized.get(m) ?? 1))
        }
      }
    },
    rings: () => rings,
    lineSamples: () => samples.map((s) => [s[0], s[1], s[2]]),
    dispose() {
      ringsGeneration++
      dropRings()
      flyby.dispose() // DEV-474
      root.removeFromParent()
      lineGeometry.dispose()
      lineMaterial.dispose()
      buriedRings.geometry.dispose()
      underLine.geometry.dispose()
      propRingLoops.geometry.dispose() // DEV-503
      propLineRuns.geometry.dispose()
      propMaterial.dispose()
      groundMaterial.dispose()
      runInLine.geometry.dispose() // DEV-486
      runInMaterial.dispose()
      shape.dispose()
      ball.dispose()
      for (const m of Object.values(materials)) m.dispose()
    },
  }
}
