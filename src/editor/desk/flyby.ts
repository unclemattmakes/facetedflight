// src/editor/desk/flyby.ts — ships flown along the race line. DEV-474
// (docs/plan/EDITOR-PLAYTEST-2026-09-27.md).
//
// Matt, in the editor: *"it'd be awesome of a ship could be sent along the
// spline every 4 seconds or so. to help visualize the race path"*. A drawn
// line says where a course goes; a ship on it says what it FLIES like — where
// it climbs, where it dives, and how hard it banks into a bend.
//
// ── What flies, and where ─────────────────────────────────────────────────
//
//  · The LINE is the expanded level's `route` (DEV-466): the course sampled
//    from its start to the end of its curve, the line the AI racers fly. Not
//    the drawn spline, which also runs back before the start. No route (an
//    invalid draft, fewer than two points) and nothing flies.
//  · The PACE is the HoverJet's unboosted cruise (`flybySpeed`, policy.ts),
//    the speed DEV-468's tight-turn warning judges a bend at, so a bend the
//    panel warns about is one the ships visibly bank hardest into.
//  · A ship is launched every `launchSeconds` and flies the line end to end.
//    The schedule is a pure function of one clock (`flybyArcs`): ship k left
//    at k·interval and is at (clock − k·interval)·speed metres. So it loops by
//    construction, and it is BOUNDED by construction: the interval stretches
//    on a line too long for `maxShips` to cover at 4 s, rather than the count
//    growing with the course.
//  · The MESH is the real exterior hull, placed under its group by the same
//    three lines `racers.ts` and the title use (`ART_POSITION`,
//    `SHIP_MODEL_YAW`, `ART_SCALE`), in the racers' hologram colours
//    (`racerMaterial`), the look 2016 gave a ship that is not you, drawn
//    solid so its shape reads at fifty pixels.
//  · It is AIMED with `aimShip` (`render/title.ts`), because the hull came
//    through the converter and flies along its own −z (CLAUDE.md, trap 22).
//    Heading and bank are both taken from the line's GEOMETRY: the heading
//    is the central chord through the ship, and the bank is the coordinated
//    turn's (lift along centripetal acceleration minus gravity) measured
//    against the ship's own axes, so no sign is typed anywhere to be wrong.
//    `tests/unit/editor-flyby.test.ts` checks both on the real hull: its
//    tapering end is further along the line, and its inside wing is lower.
//  · SIZE: a real hull where it is big enough to see, grown to a constant
//    fraction of its distance where it is not (`shipScreenFraction`). From the
//    editor's framing distance a true-size jet is two pixels.
//  · SHAPE (DEV-487): the hull only where it is big enough to read as one,
//    a dart where it is not. Matt: *"can LOD to fall back to pyramids or
//    something more obviously directional"*. From above, the hull's long end
//    is its EXHAUST (DEV-040), so at fifty pixels a ship read as flying
//    backwards. The dart is `flybyArrowGeometry`: a notched arrowhead in plan
//    and a wedge in profile, its point at the nose from above AND from the
//    side, the hull's own length, placed by the same `placeFlybyShip`.
//    `flybyLod` decides with hysteresis, per SHIP (its launch number, not its
//    pool slot, which shifts at every launch), so a ship at the boundary
//    changes shape once. The darts are ONE `InstancedMesh`, one draw call for
//    all of them; the few hulls close enough to show are one call each.
//
// Off while flying: the ships hang under the desk's root, which the desk hides
// when a playtest starts, and the editor's frame, which is the only thing that
// moves them, does not run while one flies.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { Vec3Tuple } from '@/content/level-schema'
import { PLAYER_COURSE_SHAPE } from '@/content/player-course'
import { ART_POSITION, ART_SCALE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { racerMaterial } from '@/game/racers'
import { WORLD } from '@/generated/constants.generated'
import { loadMesh } from '@/render/load-mesh'
import { aimShip } from '@/render/title'
import { FLYBY_POLICY, flybyMaxBank, flybySpeed } from './policy'

/** A route as a polyline measured by arc length. */
export interface FlybyLine {
  readonly points: readonly THREE.Vector3[]
  /** Arc length at each point, metres; `arc[0]` is 0. */
  readonly arc: Float64Array
  readonly length: number
}

/** The route, measured; null when there is no line to fly (fewer than two distinct points). */
export const flybyLine = (route: readonly Vec3Tuple[] | null | undefined): FlybyLine | null => {
  if (!route || route.length < 2) return null
  const points = route.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
  const arc = new Float64Array(points.length)
  for (let i = 1; i < points.length; i++) {
    arc[i] =
      (arc[i - 1] as number) +
      (points[i] as THREE.Vector3).distanceTo(points[i - 1] as THREE.Vector3)
  }
  const length = arc[points.length - 1] as number
  return length > 0 ? { points, arc, length } : null
}

/** The point `s` metres along the line, clamped to its ends. */
export const flybyPointAt = (line: FlybyLine, s: number, out: THREE.Vector3): THREE.Vector3 => {
  const { points, arc, length } = line
  if (s <= 0) return out.copy(points[0] as THREE.Vector3)
  if (s >= length) return out.copy(points[points.length - 1] as THREE.Vector3)
  // Binary search for the segment holding s.
  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((arc[mid] as number) <= s) lo = mid
    else hi = mid
  }
  const a = arc[lo] as number
  const b = arc[hi] as number
  return out.lerpVectors(
    points[lo] as THREE.Vector3,
    points[hi] as THREE.Vector3,
    b > a ? (s - a) / (b - a) : 0,
  )
}

/**
 * Seconds between launches on a line `length` metres long flown at `speed`:
 * Matt's interval, stretched where `maxShips` at that interval would not
 * cover the line — so the count in flight never passes `maxShips`.
 */
export const flybySpacing = (length: number, speed: number): number =>
  Math.max(FLYBY_POLICY.launchSeconds, length / speed / FLYBY_POLICY.maxShips)

/**
 * Where every ship in flight is at `clock` seconds, metres along the line,
 * nearest the start first. Pure: ship k left at k·spacing and flies at
 * `speed`; it is in flight from 0 up to (not including) `length`.
 */
export const flybyArcs = (clock: number, length: number, speed: number): number[] => {
  if (!(length > 0) || !(speed > 0)) return []
  const spacing = flybySpacing(length, speed)
  const phase = ((clock % spacing) + spacing) % spacing
  const out: number[] = []
  for (let j = 0; j < FLYBY_POLICY.maxShips; j++) {
    const s = (phase + j * spacing) * speed
    if (s >= length) break
    out.push(s)
  }
  return out
}

/**
 * The launch number of the ship `flybyArcs(clock, …)` lists FIRST (nearest
 * the start); the ship at index i is launch `base − i`. It names a ship across
 * frames, which its index does not: every launch shifts the list by one.
 */
export const flybyLaunchBase = (clock: number, spacing: number): number => {
  const phase = ((clock % spacing) + spacing) % spacing
  return Math.round((clock - phase) / spacing)
}

/** What a fly-by ship is drawn as. */
export type FlybyLod = 'hull' | 'arrow'

/**
 * DEV-487: the hull where its REAL length is at least `hullScreenFraction` of
 * its distance (`fraction` = length / distance), the arrow where it is under
 * `lodHysteresis` of that, and in between whatever the ship already was: one
 * change of shape at the boundary, not one a frame. A new ship in the band is
 * an arrow.
 */
export const flybyLod = (previous: FlybyLod | undefined, fraction: number): FlybyLod => {
  if (fraction >= FLYBY_POLICY.hullScreenFraction) return 'hull'
  if (fraction < FLYBY_POLICY.hullScreenFraction * FLYBY_POLICY.lodHysteresis) return 'arrow'
  return previous ?? 'arrow'
}

/**
 * DEV-487: the dart a small ship is drawn as, in a ship's own frame (its −z
 * the nose, +y up): `length` metres from point to tail, centred on
 * `centreZ`. Six faces, closed, wound outward, NON-indexed so each face
 * shades flat (the faceted look, and the two top faces lit differently, which
 * is what shows the ridge). In plan it is an arrowhead with a notched tail; in
 * profile a wedge, low at the point and tall over the notch. Both views point
 * the same way, and neither can be read backwards.
 */
export const flybyArrowGeometry = (length: number, centreZ = 0): THREE.BufferGeometry => {
  const { arrowWidth, arrowNotch, arrowHeight } = FLYBY_POLICY
  const w = (arrowWidth * length) / 2
  const h = arrowHeight * length
  const zNose = centreZ - length / 2
  const zTail = centreZ + length / 2
  const zNotch = zTail - arrowNotch * length
  const y0 = -h / 2
  const N = [0, y0, zNose]
  const TL = [-w, y0, zTail]
  const TR = [w, y0, zTail]
  const K = [0, y0, zNotch]
  const P = [0, y0 + h, zNotch]
  const faces = [
    [N, TL, P], // the upper face, left
    [N, P, TR], // the upper face, right
    [TL, K, P], // the notch, left wall
    [K, TR, P], // the notch, right wall
    [N, K, TL], // the underside, left
    [N, TR, K], // the underside, right
  ]
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flat(2), 3))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

const _at = new THREE.Vector3()
const _back = new THREE.Vector3()
const _ahead = new THREE.Vector3()
const _target = new THREE.Vector3()
const _accel = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _m = new THREE.Matrix3()

/**
 * Put `ship` `s` metres along `line`, nose along the line, banked into its
 * bend as a coordinated turn at `speed`. Exported for the unit test, which
 * measures what it does on the real hull.
 */
export const placeFlybyShip = (
  ship: THREE.Object3D,
  line: FlybyLine,
  s: number,
  speed: number,
): void => {
  // The central chord through the ship, one route spacing each way: the
  // route is resampled every `routeSpacingMetres`, so the chord spans at least
  // one of its corners and turns smoothly as the ship moves.
  const h = PLAYER_COURSE_SHAPE.routeSpacingMetres
  flybyPointAt(line, s, _at)
  flybyPointAt(line, s - h, _back)
  flybyPointAt(line, s + h, _ahead)
  ship.position.copy(_at)
  _forward.subVectors(_ahead, _back)
  if (_forward.lengthSq() < 1e-9) return
  // The heading, by the converter's convention (trap 22): unbanked first.
  _target.copy(_at).add(_forward)
  aimShip(ship, _target, 0)
  // The bank: a coordinated turn's lift lies along (centripetal acceleration
  // − gravity). The curvature is the second difference over the same chord,
  // valid where the chord did not run off an end of the line.
  const back = Math.min(h, s)
  const ahead = Math.min(h, line.length - s)
  if (back < h || ahead < h) return
  _accel
    .copy(_ahead)
    .add(_back)
    .addScaledVector(_at, -2)
    .multiplyScalar((speed * speed) / (h * h))
  _accel.x -= WORLD.gravity.x
  _accel.y -= WORLD.gravity.y
  _accel.z -= WORLD.gravity.z
  // Measured against the ship's own axes after the aim, so the roll's sign is
  // a fact about the geometry, not a convention typed here: rotating about
  // local z by θ carries local +y to cos θ·y − sin θ·x.
  ship.updateMatrix()
  _m.setFromMatrix4(ship.matrix)
  _x.set(1, 0, 0).applyMatrix3(_m).normalize()
  _y.set(0, 1, 0).applyMatrix3(_m).normalize()
  const limit = flybyMaxBank()
  const roll = THREE.MathUtils.clamp(Math.atan2(-_accel.dot(_x), _accel.dot(_y)), -limit, limit)
  ship.rotateZ(roll)
}

/**
 * The prototype every fly-by ship is cloned from: the exterior hull, placed
 * under a group at the ship's origin as `racers.ts` places a racer's art, in
 * the racers' hologram. The group's origin is the ship's; its −z is the nose.
 */
export const loadFlybyShip = async (): Promise<THREE.Object3D> => {
  const gltf = await loadMesh(assetUrl(SHIP_MESH_EXTERIOR))
  // The hologram's colours, drawn SOLID: at 50 px, a see-through, double-sided
  // hull over the island read as a pale blob in the first photographs, its
  // wings and its nose lost in its own overlapping faces.
  const material = racerMaterial()
  material.transparent = false
  material.opacity = 1
  material.depthWrite = true
  return flybyShipFrom(gltf.object, material)
}

/** The prototype from an already-loaded hull (the unit test parses the GLB off disk). */
export const flybyShipFrom = (hull: THREE.Object3D, material: THREE.Material): THREE.Object3D => {
  hull.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) mesh.material = material
  })
  hull.position.copy(ART_POSITION)
  hull.rotation.y = SHIP_MODEL_YAW
  hull.scale.copy(ART_SCALE)
  const ship = new THREE.Group()
  ship.name = 'editor-flyby-prototype'
  ship.add(hull)
  return ship
}

/** What the e2e spec reads off the group's `userData.flyby`. Plain values. */
export interface FlybyState {
  readonly launchSeconds: number
  readonly spacingSeconds: number
  readonly speed: number
  readonly maxShips: number
  /** The line's length, metres (0 with no line). */
  readonly length: number
  /** Ships in flight now. */
  readonly inFlight: number
  /** DEV-487: of those, how many are drawn as the hull and how many as the arrow. */
  readonly hulls: number
  readonly arrows: number
}

export interface Flyby {
  readonly object: THREE.Group
  /** The line to fly: the expanded level's `route`, or null for none. */
  setRoute(route: readonly Vec3Tuple[] | null | undefined): void
  /** The mesh to fly, once it has loaded. Until then nothing is drawn. */
  setPrototype(prototype: THREE.Object3D): void
  /** Advance the clock by `seconds` (clamped) and place every ship; sized for `camera`. */
  update(seconds: number, camera: THREE.Camera): void
  /** The ships in flight: where each is, how far along the line, and what it is drawn as. */
  ships(): { position: THREE.Vector3; arc: number; lod: FlybyLod }[]
  dispose(): void
}

export const createFlyby = (): Flyby => {
  const object = new THREE.Group()
  object.name = 'editor-flyby'
  const speed = flybySpeed()
  let line: FlybyLine | null = null
  let prototype: THREE.Object3D | null = null
  /** The hull's real length, metres: its longest extent. */
  let hullLength = 1
  const pool: THREE.Object3D[] = []
  /** Each pooled ship's hull (the prototype's one child), shown or hidden by its LOD. */
  const hulls: THREE.Object3D[] = []
  /** DEV-487: the arrows, one instance per ship drawn as one. Built with the prototype. */
  let arrows: THREE.InstancedMesh | null = null
  /** DEV-487: what each ship in flight is drawn as, keyed by its LAUNCH number (not its slot). */
  const lods = new Map<number, FlybyLod>()
  let arcs: number[] = []
  let shown: FlybyLod[] = []
  let clock = 0
  let disposed = false
  const _eye = new THREE.Vector3()

  const state = (): FlybyState => ({
    launchSeconds: FLYBY_POLICY.launchSeconds,
    spacingSeconds: line ? flybySpacing(line.length, speed) : FLYBY_POLICY.launchSeconds,
    speed,
    maxShips: FLYBY_POLICY.maxShips,
    length: line ? line.length : 0,
    inFlight: prototype ? arcs.length : 0,
    hulls: shown.filter((l) => l === 'hull').length,
    arrows: shown.filter((l) => l === 'arrow').length,
  })
  object.userData.flyby = state()

  return {
    object,
    setRoute(route) {
      line = flybyLine(route)
      // A new line has a new spacing, so the launch numbers name other ships.
      lods.clear()
    },
    setPrototype(p) {
      if (disposed) return
      prototype = p
      const box = new THREE.Box3().setFromObject(p)
      const size = box.getSize(new THREE.Vector3())
      hullLength = Math.max(size.x, size.y, size.z) || 1
      for (let i = 0; i < FLYBY_POLICY.maxShips; i++) {
        const ship = p.clone()
        ship.name = `editor-flyby-ship:${i}`
        ship.visible = false
        pool.push(ship)
        hulls.push(ship.children[0] ?? ship)
        object.add(ship)
      }
      // The arrow spans the hull's own nose-to-tail extent (its z, the aim's
      // axis), in the hull's own material: one geometry, one draw call.
      const materials: THREE.Material[] = []
      p.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (mesh.isMesh) materials.push(mesh.material as THREE.Material)
      })
      arrows = new THREE.InstancedMesh(
        flybyArrowGeometry(size.z || hullLength, box.getCenter(new THREE.Vector3()).z),
        materials[0] ?? new THREE.MeshBasicMaterial(),
        FLYBY_POLICY.maxShips,
      )
      arrows.name = 'editor-flyby-arrows'
      arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // The instances move every frame; a bounding sphere computed once would
      // cull them where they were.
      arrows.frustumCulled = false
      arrows.count = 0
      object.add(arrows)
    },
    update(seconds, camera) {
      clock += Math.min(Math.max(seconds, 0), FLYBY_POLICY.maxStepSeconds)
      arcs = line ? flybyArcs(clock, line.length, speed) : []
      const base = line ? flybyLaunchBase(clock, flybySpacing(line.length, speed)) : 0
      shown = []
      camera.getWorldPosition(_eye)
      let drawnArrows = 0
      for (let i = 0; i < pool.length; i++) {
        const ship = pool[i] as THREE.Object3D
        const s = arcs[i]
        if (!line || s === undefined) {
          ship.visible = false
          continue
        }
        ship.visible = true
        placeFlybyShip(ship, line, s, speed)
        const d = ship.position.distanceTo(_eye)
        ship.scale.setScalar(Math.max(1, (d * FLYBY_POLICY.shipScreenFraction) / hullLength))
        // DEV-487: the hull where its real size reads, the arrow where it does not.
        const launch = base - i
        const lod = flybyLod(lods.get(launch), d > 0 ? hullLength / d : Number.POSITIVE_INFINITY)
        lods.set(launch, lod)
        shown.push(lod)
        ship.userData.lod = lod
        ;(hulls[i] as THREE.Object3D).visible = lod === 'hull'
        if (lod === 'arrow' && arrows) {
          // The arrow and the ships share a parent, so a ship's own matrix places its arrow.
          ship.updateMatrix()
          arrows.setMatrixAt(drawnArrows++, ship.matrix)
        }
      }
      // Forget ships that have landed.
      for (const launch of lods.keys()) {
        if (launch > base || launch <= base - arcs.length) lods.delete(launch)
      }
      if (arrows) {
        arrows.count = drawnArrows
        arrows.visible = drawnArrows > 0
        arrows.instanceMatrix.needsUpdate = true
      }
      object.userData.flyby = state()
    },
    ships() {
      if (!prototype || !line) return []
      const l = line
      return arcs.map((s, i) => ({
        position: flybyPointAt(l, s, new THREE.Vector3()),
        arc: s,
        lod: shown[i] ?? 'arrow',
      }))
    },
    dispose() {
      disposed = true
      object.removeFromParent()
      object.clear()
      pool.length = 0
      hulls.length = 0
      lods.clear()
      // The arrows' geometry is their own; their material is the hull's, disposed below.
      arrows?.geometry.dispose()
      arrows?.dispose()
      arrows = null
      // The clones share the prototype's geometry and material: dispose once.
      prototype?.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry.dispose()
        const m = mesh.material as THREE.Material | THREE.Material[]
        for (const x of Array.isArray(m) ? m : [m]) x.dispose()
      })
      prototype = null
    },
  }
}
