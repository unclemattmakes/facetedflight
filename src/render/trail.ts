// src/render/trail.ts — Unity's legacy `TrailRenderer`, which three has no
// equivalent of.
//
// Matt: *"it'd be nice to get the vfx trail from the ghost/ai engines we used to
// have (helped players see the ai jets)."*
//
// There is exactly ONE TrailRenderer in the shipped game and it is on
// `GhostRacer.prefab`. `PlayerShip_SR14_Photon.prefab` has none. So this was
// never a jet effect for its own sake — it is a read on where the opposition
// is, which is why it matters more in a headset than it did on a monitor.
//
// ── What a legacy TrailRenderer actually does ─────────────────────────────
//
// It is a WORLD-SPACE, camera-facing ribbon:
//
//  * The head vertex is pinned to the emitter every frame. It does not lag.
//  * A point is COMMITTED to the history only once the emitter has moved
//    `minVertexDistance` from the last committed one. That is what keeps the
//    ribbon's shape stable across frame rates — the point COUNT still varies,
//    but where the points are does not.
//  * A committed point is dropped when its age passes `time`.
//  * Width lerps `startWidth` -> `endWidth` with age, so the ribbon tapers to a
//    point rather than fading out.
//
// Because the geometry is world-space, this mesh sits at the scene root with an
// identity transform and its vertex positions ARE world positions. Parenting it
// to the ship is the obvious mistake and it produces a trail that turns with
// the ship instead of being left behind by it.
//
// ── The five colour stops are inert, and that is a finding, not a shortcut ─
//
// `m_Colors` carries five `Color32` stops with alphas 255, 122, 192, 69, 14.
// None of them ever reached a pixel:
//
//  * The material is `glowyMaterial.mat` on `Marmoset/Self-Illumin/Specular
//    IBL`, whose SubShader declares `"Queue"="Geometry" "RenderType"="Opaque"`.
//    So no alpha blended — including `_Color`'s own 0.891.
//  * Marmoset's `Input` struct only declares `half4 color : COLOR` under
//    `MARMO_VERTEX_COLOR` / `MARMO_PACKED_VERTEX_COLOR`. That shader `#pragma
//    multi_compile`s neither, and the material's `m_ShaderKeywords` is EMPTY.
//    So the RGB never reached the surface function either.
//
// The 2016 trail was therefore a uniform cyan-white ribbon — the same
// `glowyMaterial` the checkpoint rings' studs wear, which is why it reads as
// the same colour as the gates. This builds no vertex colours at all. The stops
// stay in the constants sheet because they are what shipped; they are not used
// because they did nothing.

import * as THREE from 'three'

/** The four numbers that describe a trail, straight off the TrailRenderer. */
export interface TrailSpec {
  /** `m_Time` — how long a committed point survives, seconds. */
  readonly seconds: number
  /** `m_StartWidth` — at the head, where the ribbon meets the ship. */
  readonly startWidth: number
  /** `m_EndWidth` — at the tail. */
  readonly endWidth: number
  /** `m_MinVertexDistance` — how far the emitter moves before a point commits. */
  readonly minVertexDistance: number
  /**
   * Ring capacity. The shipped trail needs far fewer: at 0.14 s and 0.25 m
   * spacing a 180 m/s racer commits one point per 1.4 ms, but frames are ~11 ms
   * at 90 Hz, so it commits one per FRAME and holds about 13. The cap is a
   * backstop against a slow frame followed by a fast one, not a budget.
   */
  readonly maxPoints?: number
}

export interface Trail {
  /** Add this to the scene ROOT. Its vertices are world positions. */
  readonly object: THREE.Mesh
  /**
   * Pin the head to `emitter`, age the ribbon, and rebuild it facing `eye`.
   *
   * `dt` is a FRAME delta, not the sim step: a trail is decoration and 2016
   * sampled it per frame in `LateUpdate`, not per fixed step.
   */
  update(emitter: THREE.Vector3, eye: THREE.Vector3, dt: number): void
  /**
   * Throw the history away.
   *
   * Call this whenever the emitter TELEPORTS — a race restart, a respawn, a
   * ghost seeking to a new time. Without it the ribbon draws one enormous
   * quad from wherever the ship used to be.
   */
  reset(): void
  dispose(): void
}

const DEFAULT_MAX_POINTS = 64

/**
 * Above this, the emitter was MOVED rather than flown, and the history is
 * thrown away instead of drawing a ribbon across the jump.
 *
 * 1 km/s is not a tuning value, it is a backstop: the shipped ship tops out
 * near 180 m/s, which is 2 m in a 90 Hz frame and 12 m in a dreadful 15 Hz one,
 * so nothing that is actually flying can reach this. A race restart or a
 * respawn moves hundreds of metres in one frame and trips it every time.
 * Callers that KNOW a teleport is coming should call `reset()` and not rely on
 * this at all.
 */
const TELEPORT_SPEED = 1000

export const createTrail = (spec: TrailSpec, material: THREE.Material): Trail => {
  const maxPoints = Math.max(2, spec.maxPoints ?? DEFAULT_MAX_POINTS)

  // Committed history, newest FIRST, as (x, y, z, age) quads. Index 0 is the
  // live head and is rewritten every frame; 1.. are committed.
  const pts = new Float32Array(maxPoints * 4)
  let count = 0

  /**
   * The last COMMITTED position, which is what `minVertexDistance` is measured
   * from — not the head.
   *
   * The head is rewritten to the emitter every frame, so measuring against it
   * only ever asks "how far did we move THIS frame", which at 90 Hz is a
   * fraction of the threshold. Nothing would ever commit and the ribbon would
   * stay one point long: a trail that is always empty, with no error anywhere.
   */
  const anchor = new Float32Array(3)

  const positions = new Float32Array(maxPoints * 2 * 3)
  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3)
  positionAttribute.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)

  // The index buffer is the same every frame; only `drawRange` moves.
  const indices = new Uint16Array((maxPoints - 1) * 6)
  for (let i = 0; i < maxPoints - 1; i++) {
    const a = i * 2
    indices[i * 6] = a
    indices[i * 6 + 1] = a + 1
    indices[i * 6 + 2] = a + 2
    indices[i * 6 + 3] = a + 2
    indices[i * 6 + 4] = a + 1
    indices[i * 6 + 5] = a + 3
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.setDrawRange(0, 0)

  const object = new THREE.Mesh(geometry, material)
  object.name = 'trail'
  // The vertices are world positions, so the object must not carry a transform
  // of its own — and its bounds change every frame, which makes three's cached
  // bounding sphere worse than useless for culling.
  object.matrixAutoUpdate = false
  object.frustumCulled = false

  // Volatile scratch. Valid only inside one synchronous `update`.
  const dir = new THREE.Vector3()
  const view = new THREE.Vector3()
  const side = new THREE.Vector3()
  /**
   * The last usable width axis, for the one case that has no answer of its own:
   * a view ray exactly along the tangent. Rolls point to point and frame to
   * frame, because "the same as its neighbour" is the only property that
   * matters when the ribbon is edge-on and a pixel wide.
   */
  const lastSide = new THREE.Vector3(1, 0, 0)

  const reset = (): void => {
    count = 0
    geometry.setDrawRange(0, 0)
  }

  /**
   * The float offset of the nearest point to `i` in `step` whose position
   * differs from `i`'s, falling back to `i` itself at the ends.
   *
   * Coincident points are normal, not a defect: a commit writes the new point
   * at the emitter, which is exactly where the head is on that frame.
   */
  const distinctFrom = (i: number, step: number): number => {
    const bx = pts[i * 4] as number
    const by = pts[i * 4 + 1] as number
    const bz = pts[i * 4 + 2] as number
    for (let j = i + step; j >= 0 && j < count; j += step) {
      const b = j * 4
      const dx = (pts[b] as number) - bx
      const dy = (pts[b + 1] as number) - by
      const dz = (pts[b + 2] as number) - bz
      if (dx * dx + dy * dy + dz * dz > 1e-12) return b
    }
    return i * 4
  }

  /** How far the emitter moved THIS frame — the teleport test. */
  const distanceToHeadSq = (emitter: THREE.Vector3): number => {
    const dx = emitter.x - (pts[0] as number)
    const dy = emitter.y - (pts[1] as number)
    const dz = emitter.z - (pts[2] as number)
    return dx * dx + dy * dy + dz * dz
  }

  /** How far since the last commit — the `minVertexDistance` test. */
  const distanceToAnchorSq = (emitter: THREE.Vector3): number => {
    const dx = emitter.x - (anchor[0] as number)
    const dy = emitter.y - (anchor[1] as number)
    const dz = emitter.z - (anchor[2] as number)
    return dx * dx + dy * dy + dz * dz
  }

  const start = (emitter: THREE.Vector3): void => {
    pts[0] = emitter.x
    pts[1] = emitter.y
    pts[2] = emitter.z
    pts[3] = 0
    anchor[0] = emitter.x
    anchor[1] = emitter.y
    anchor[2] = emitter.z
    count = 1
  }

  return {
    object,

    update(emitter: THREE.Vector3, eye: THREE.Vector3, dt: number): void {
      if (count === 0) {
        start(emitter)
        geometry.setDrawRange(0, 0)
        return
      }

      // A move no flight could make means the transform was set, not flown.
      const jumpLimit = TELEPORT_SPEED * Math.max(dt, 1e-6)
      if (distanceToHeadSq(emitter) > jumpLimit * jumpLimit) {
        reset()
        start(emitter)
        return
      }

      // ── age, and drop the tail ──────────────────────────────────────────
      for (let i = 1; i < count; i++) pts[i * 4 + 3] = (pts[i * 4 + 3] as number) + dt
      while (count > 1 && (pts[(count - 1) * 4 + 3] as number) > spec.seconds) count--

      // ── commit, if the emitter has moved far enough ─────────────────────
      //
      // Committed points are inserted at 1, so index 0 stays the live head.
      const minSq = spec.minVertexDistance * spec.minVertexDistance
      if (distanceToAnchorSq(emitter) >= minSq) {
        if (count < maxPoints) count++
        // Shift 1.. down by one to make room; the old head becomes the newest
        // committed point, carrying the age it has already accrued (0).
        // Old entries 1..count-2 slide to 2..count-1. When the ring is already
        // full nothing grew, so the same copy drops the oldest point.
        pts.copyWithin(8, 4, (count - 1) * 4)
        pts[4] = emitter.x
        pts[5] = emitter.y
        pts[6] = emitter.z
        pts[7] = 0
        anchor[0] = emitter.x
        anchor[1] = emitter.y
        anchor[2] = emitter.z
      }

      // The head is ALWAYS the emitter. Unity's trail does not lag behind the
      // transform; only the committed points do.
      pts[0] = emitter.x
      pts[1] = emitter.y
      pts[2] = emitter.z
      pts[3] = 0

      if (count < 2) {
        geometry.setDrawRange(0, 0)
        return
      }

      // ── build the ribbon ────────────────────────────────────────────────
      for (let i = 0; i < count; i++) {
        const b = i * 4
        const px = pts[b] as number
        const py = pts[b + 1] as number
        const pz = pts[b + 2] as number

        // ── the tangent, skipping COINCIDENT neighbours ─────────────────
        //
        // On the frame a point commits, it is written AT the emitter — so the
        // head and the newest committed point are the same position and the
        // naive `points[i-1] - points[i+1]` is the zero vector. At 180 m/s a
        // commit lands almost every frame, so the head's tangent was
        // alternating between the real one and a fallback, and the head quad
        // flipped orientation with it. That is a flicker you cannot see coming
        // from the maths, only from the frame rate.
        const prev = distinctFrom(i, -1)
        const next = distinctFrom(i, 1)
        dir.set(
          (pts[prev] as number) - (pts[next] as number),
          (pts[prev + 1] as number) - (pts[next + 1] as number),
          (pts[prev + 2] as number) - (pts[next + 2] as number),
        )

        // Camera-facing: the width axis is perpendicular to both the tangent
        // and the line of sight, so it reads the same from anywhere.
        //
        // Both operands are normalised first, so the cross product's length is
        // |sin(angle)| between them and the degenerate test below means what it
        // says. Unnormalised it also shrinks as the points get closer, which at
        // 0.25 m spacing is all the time.
        const dirLen = dir.length()
        if (dirLen > 1e-9) dir.multiplyScalar(1 / dirLen)
        else dir.set(0, 0, 1)
        view.set(px - eye.x, py - eye.y, pz - eye.z)
        const viewLen = view.length()
        if (viewLen > 1e-9) view.multiplyScalar(1 / viewLen)
        else view.set(0, 0, 1)

        side.crossVectors(dir, view)
        const sinAngle = side.length()
        if (sinAngle > 1e-6) {
          side.multiplyScalar(1 / sinAngle)
        } else {
          // Exactly along the tangent — the one view direction with no answer.
          // Carry the last axis forward, re-perpendicularised so it is still a
          // legal ribbon normal.
          side.copy(lastSide).addScaledVector(dir, -lastSide.dot(dir))
          const fixLen = side.length()
          if (fixLen > 1e-6) {
            side.multiplyScalar(1 / fixLen)
          } else {
            // It had collapsed onto the tangent. Any perpendicular will do.
            side.set(-dir.y, dir.x, 0)
            if (side.lengthSq() < 1e-12) side.set(0, -dir.z, dir.y)
            side.normalize()
          }
        }
        lastSide.copy(side)

        const t = Math.min(1, (pts[b + 3] as number) / Math.max(spec.seconds, 1e-6))
        const half = (spec.startWidth + (spec.endWidth - spec.startWidth) * t) * 0.5

        const o = i * 6
        positions[o] = px + side.x * half
        positions[o + 1] = py + side.y * half
        positions[o + 2] = pz + side.z * half
        positions[o + 3] = px - side.x * half
        positions[o + 4] = py - side.y * half
        positions[o + 5] = pz - side.z * half
      }

      positionAttribute.needsUpdate = true
      geometry.setDrawRange(0, (count - 1) * 6)
    },

    reset,

    dispose(): void {
      geometry.dispose()
    },
  }
}
