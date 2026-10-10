// src/render/prop-fracture.ts — a tree comes apart in paper. DEV-136.
//
// When `sim/props/collision.ts` reports a break, the renderer swaps the prop's
// instance for its own facets flying apart: the glTF's triangles are split
// ONCE per geometry into a handful of chunks by the direction of each face's
// centroid about the prop's vertical axis, and a break spawns one Mesh per
// chunk at the instance's matrix, moving outward along the chunk's own mean
// direction, tumbling, falling under the world's (0, −32, 0), and fading over
// `seconds`. Then they are removed and their materials disposed; the chunk
// geometries are cached and shared.
//
// ── Register ─────────────────────────────────────────────────────────────
//
// ART_DIRECTION pillar 2: one colour per face and never a texture. A chunk is
// the prop's own faces with the prop's own vertex colours — the same
// `MeshStandardMaterial` the instance drew with, cloned so its opacity can fade
// without touching the forest. Paper-cut pieces, one colour per face, no
// particles, no smoke. Nothing here glows.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// Not the sim. The sim forgot the prop the tick it broke; everything here runs
// on the RENDER clock and touches nothing a golden trajectory could see. And
// not a physics engine: a piece is a position, a velocity, a spin and a clock.
//
// That boundary is the FIRST question DEV-148 had to answer, and it was already
// answered correctly: a piece is decoration, so it may use a frame delta (hard
// rule 5 binds `src/sim/`, not this), it may not feed anything back, and the
// fix for "they fall through the hill" belongs here rather than in a sim body.
//
// ── The ground, and WHICH ground (DEV-148) ───────────────────────────────
//
// The pieces used to fall for ever: nothing here asked where the hill was, and
// DEV-136 §4 said so — *"No pieces collide with the terrain; they fall through
// it and fade first."* Watched from the cockpit that is a tree that explodes
// into shards which sink into the ground, which is worse than no fracture.
//
// A piece rests when it MEETS the surface, and the surface it meets is the one
// you can SEE — `sim/terrain/surface.ts`'s `renderSurfaceHeightAt`, walking the
// same jittered vertex grid the chunks were built from — and NOT
// `terrainHeightAt`, the collision field. CLAUDE.md says it in four words:
// *"`heightField` is NOT what you see."* They differ by up to `randomOffset`
// per vertex (1.3 m on Simonet, 0.8 m elsewhere) and resting a visible object
// on the invisible one is exactly DEV-134's floating forest, one layer down.
// The caller hands in the query; this file does not know what a terrain is.
//
// "Meets" is the lowest corner of the piece's own bounding box under its
// current rotation, not its origin — a chunk's origin is the PROP's base, so a
// crown shard resting on its origin would have two thirds of itself buried.
// The box is a conservative bound on the geometry inside it, so a long shard
// lying at an angle can rest up to about its own half-width proud of the
// ground. That is the direction to be wrong in: floating a little is a
// judgement, sinking is the bug.
//
// ── The piece's MATERIAL, and the 200 ms it used to cost (DEV-177) ───────
//
// A piece drew with `material.clone()`, and a clone is not a copy of the two
// things that decide which PROGRAM it gets. `Material.copy` carries neither
// `onBeforeCompile` nor `customProgramCacheKey` (three 0.185.1), and three's
// default key is `this.onBeforeCompile.toString()` — so a clone of a patched
// prop material came out with the EMPTY prototype callback and the empty
// prototype's source as its key. Two consequences, and the second one is the
// one that was measured:
//
//   1. The pieces drew with **no Unity fog and no far-field sun term**. Every
//      chained patch the prop carries (`fog.applyTo`, `farShadow.applyTo`) was
//      dropped on the floor, silently, because `onBeforeCompile` is a callback
//      three invokes rather than state it copies.
//   2. The first break of a run **compiled a GLSL program in the seat**. Flat
//      trace, `int_01` autopilot: `programs 93 -> 94` at the break, `94 -> 93`
//      1.5 s later when the last piece faded and the clone was disposed — a
//      program that lives as long as a fracture. The frame cost 200 ms, of
//      which `render_ms` 197.6 and GPU 188.
//
// So the clone delegates both hooks back to the base, exactly as
// `render/lod-fade.ts` does for its fade clones: `call(base, …)` because every
// patch in the chain was written against `material`, not `this`. The piece is
// then the PROP's shader, fog and all.
//
// That still leaves ONE program, and it cannot be avoided: three's cache key
// carries `instancing` (the prop is an `InstancedMesh`, a piece is a plain
// `Mesh`) and `opaque` (`transparent === false && …`, and a piece fades). Both
// are three's own parameters, not our GLSL — no amount of tagging collapses
// them. So the piece variant is warmed instead, and the materials are POOLED
// rather than disposed: a disposed material releases its program, and the next
// break would compile it again.
//
// `prime()` is the warm. It hangs an invisible mesh carrying each piece
// material under this group before `render/warm-up.ts` runs, because
// `WebGLRenderer.compile` traverses the scene with `traverse`, not
// `traverseVisible` — so the warm-up's own `compile(scene, camera)` builds the
// piece's program **inside the render-target binding and the light count the
// flight will use**, which is the whole of DEV-117's lesson and the reason this
// does not just call `compile` somewhere convenient.

import * as THREE from 'three'
import { GRAVITY } from '@/sim/constants'
import { type CloneStateOptions, delegatingClone, resyncClone } from './delegating-clone'

/** A piece owns its defines object, spread from the prop's (DEV-685). */
const PIECE_STATE: CloneStateOptions = { defines: 'copy' }

/** How many chunks a prop breaks into. Six sectors about the vertical axis. */
export const FRACTURE_CHUNKS = 6
/**
 * Outward speed of a piece along its own mean direction, m/s, and the share of
 * the ship's speed carried into the pieces. Render tuning, not the sim's: a
 * piece that leaves at 8 m/s clears a 6 m crown in under a second, and 0.12 of
 * a 90 m/s ship is 11 m/s of shove down the flight line — enough to read as
 * "hit", not enough to outrun the eye.
 */
const OUTWARD_SPEED = 8
const SHOVE_FRACTION = 0.12
/** Radians per second a piece tumbles at, scaled by a per-chunk sign. */
const TUMBLE_RATE = 2.5

interface Chunk {
  readonly geometry: THREE.BufferGeometry
  /** Mean direction of the chunk's faces from the prop axis, local, horizontal-ish. */
  readonly direction: THREE.Vector3
  /**
   * The eight corners of the chunk's own bounding box, LOCAL. Rotated per
   * frame to find how far the piece hangs below its origin right now — see the
   * header. Eight points, so this is nothing next to the chunk's real vertex
   * count and it can never let a piece sink.
   */
  readonly corners: readonly THREE.Vector3[]
}

/** A piece's material, and the prop material it was made from (its pool key). */
type PieceMaterial = THREE.Material & { opacity: number }

interface Piece {
  readonly mesh: THREE.Mesh
  readonly material: PieceMaterial
  /** The PROP material this piece's material was cloned from — its pool key. */
  readonly base: THREE.Material
  readonly velocity: THREE.Vector3
  readonly spinAxis: THREE.Vector3
  readonly spin: number
  readonly corners: readonly THREE.Vector3[]
  /** Landed. Stops moving and just fades out; the ground is not queried again. */
  grounded: boolean
  age: number
}

/**
 * Where the ground is under a point, in the FRACTURE GROUP's own frame.
 *
 * `x` and `z` are that frame's, and the answer is a `y` in it. Null where
 * there is no surface to land on, and then a piece falls as it always did.
 * The caller owns the conversion — this file has no terrain and no opinion
 * about which of the three surfaces (DEV-148: the RENDERED one) is right.
 */
export type FractureGround = (x: number, z: number) => number

/**
 * One drawn prop: the geometry and material an `InstancedMesh` carries. What
 * `prime` needs, and the same pair `break` is handed.
 */
export interface PropSource {
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.Material
}

export interface PropFracture {
  readonly group: THREE.Group
  /** Pieces in the air right now. */
  readonly live: number
  /** Pieces that have landed and are lying there fading. DEV-148's readout. */
  readonly landed: number
  /** Piece materials made so far, pooled or in use. The compile count (DEV-177). */
  readonly materialCount: number
  /**
   * Make the piece material for every distinct prop material NOW, and hang an
   * invisible mesh carrying each one under `group` so the warm-up's own
   * `compile` builds its program under the curtain (DEV-177).
   *
   * Call it BEFORE `render/warm-up.ts`'s `warmWorld`, and call the returned
   * function after — it takes the meshes back out. The MATERIALS stay, pooled:
   * a disposed material releases its program, which is the thing being paid
   * for here.
   *
   * Returns the number of distinct piece materials primed, so a caller that
   * logs a zero knows the warm did nothing.
   */
  prime(sources: readonly PropSource[]): { readonly materials: number; done(): void }
  /**
   * Break one instance. `matrix` is the instance's matrix in `group`'s parent
   * frame (the terrain group), `impact` the ship's velocity in that frame.
   */
  break(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrix: THREE.Matrix4,
    impact: THREE.Vector3,
  ): void
  update(dt: number): void
  dispose(): void
}

/**
 * Split a geometry's triangles into `FRACTURE_CHUNKS` sectors about its local
 * y axis. Works on indexed and non-indexed geometry; carries position, normal
 * and color when present. Cached by the caller.
 */
export const splitIntoChunks = (geometry: THREE.BufferGeometry): Chunk[] => {
  const src = geometry.index ? geometry.toNonIndexed() : geometry
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const nor = src.getAttribute('normal') as THREE.BufferAttribute | undefined
  const col = src.getAttribute('color') as THREE.BufferAttribute | undefined
  const triCount = pos.count / 3

  // Centre of the prop in plan, so a mesh whose pivot is off to one side (the
  // spires) still splits about its own middle.
  src.computeBoundingBox()
  const bb = src.boundingBox as THREE.Box3
  const cx = (bb.min.x + bb.max.x) / 2
  const cz = (bb.min.z + bb.max.z) / 2

  const buckets: number[][] = Array.from({ length: FRACTURE_CHUNKS }, () => [])
  for (let t = 0; t < triCount; t++) {
    const i = t * 3
    const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 - cx
    const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 - cz
    const a = Math.atan2(mz, mx) + Math.PI
    const sector = Math.min(FRACTURE_CHUNKS - 1, Math.floor((a / (Math.PI * 2)) * FRACTURE_CHUNKS))
    ;(buckets[sector] as number[]).push(t)
  }

  const chunks: Chunk[] = []
  for (const tris of buckets) {
    if (tris.length === 0) continue
    const p = new Float32Array(tris.length * 9)
    const n = nor ? new Float32Array(tris.length * 9) : null
    const c = col ? new Float32Array(tris.length * col.itemSize * 3) : null
    const direction = new THREE.Vector3()
    let w = 0
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k
        p[w * 3] = pos.getX(i)
        p[w * 3 + 1] = pos.getY(i)
        p[w * 3 + 2] = pos.getZ(i)
        if (n && nor) {
          n[w * 3] = nor.getX(i)
          n[w * 3 + 1] = nor.getY(i)
          n[w * 3 + 2] = nor.getZ(i)
        }
        if (c && col) {
          for (let j = 0; j < col.itemSize; j++) c[w * col.itemSize + j] = col.getComponent(i, j)
        }
        direction.x += pos.getX(i) - cx
        direction.z += pos.getZ(i) - cz
        w++
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    if (n) g.setAttribute('normal', new THREE.BufferAttribute(n, 3))
    if (c && col) g.setAttribute('color', new THREE.BufferAttribute(c, col.itemSize))
    // A chunk with no horizontal extent (a trunk core) goes straight up.
    if (direction.lengthSq() < 1e-6) direction.set(0, 1, 0)
    else direction.normalize()
    g.computeBoundingBox()
    const cb = g.boundingBox as THREE.Box3
    const corners: THREE.Vector3[] = []
    for (const ix of [cb.min.x, cb.max.x]) {
      for (const iy of [cb.min.y, cb.max.y]) {
        for (const iz of [cb.min.z, cb.max.z]) corners.push(new THREE.Vector3(ix, iy, iz))
      }
    }
    chunks.push({ geometry: g, direction, corners })
  }
  return chunks
}

export const createPropFracture = (
  seconds: number,
  /** Where the ground is, in this group's frame (DEV-148). Null: nothing to land on. */
  ground: FractureGround | null = null,
): PropFracture => {
  const group = new THREE.Group()
  group.name = 'props:fracture'
  const cache = new Map<string, Chunk[]>()
  const pieces: Piece[] = []
  /**
   * Piece materials, free list per PROP material. Never disposed while the
   * fracture lives — see the header: disposing one releases its program, and
   * the next break pays 200 ms to compile it again.
   */
  const pool = new Map<THREE.Material, PieceMaterial[]>()
  let materialsMade = 0
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const spinQ = new THREE.Quaternion()
  const corner = new THREE.Vector3()

  /**
   * How far the piece's own box hangs below its origin, right now.
   *
   * The eight corners under the current rotation and scale — the OBB. Never
   * the origin alone: a chunk's origin is the PROP's placement point, so a
   * crown shard resting on it would be two thirds underground.
   */
  const dropBelowOrigin = (p: Piece): number => {
    let lowest = 0
    for (const c of p.corners) {
      corner.copy(c).multiply(p.mesh.scale).applyQuaternion(p.mesh.quaternion)
      if (corner.y < lowest) lowest = corner.y
    }
    return lowest
  }

  /**
   * A piece material for `base`: its clone, fading, with BOTH hooks delegated.
   *
   * `Material.copy` carries neither, and three's default key is
   * `onBeforeCompile.toString()` — so without these two lines the piece drew
   * with the empty prototype callback (no fog, no far shadow) under a key of
   * its own, and compiled a program the first time a prop broke. DEV-177.
   *
   * No `tagProgramCacheKey` here, deliberately: the tag exists to name ways the
   * INJECTED SOURCE can differ, and a piece's injected source is the base's,
   * character for character. What differs is three's own `instancing` and
   * `opaque`, which a tag cannot touch and `prime` warms instead.
   */
  const makePieceMaterial = (base: THREE.Material): PieceMaterial => {
    // The recipe is `render/delegating-clone.ts`'s: both hooks, DEV-192's
    // point-light cut (the piece is the PROP's shader, point lights and all),
    // the base's key, and the base's runtime DEFINES, which `Material.copy`
    // wipes (DEV-685). The hooks read `base.defines` (far-shadow's canopy
    // splice does) while three compiles the piece's program from the PIECE's,
    // so a piece without them took the `#ifdef FF2_CANOPY_OBJECT` blocks the
    // other way.
    const piece = delegatingClone(base, PIECE_STATE) as PieceMaterial
    piece.transparent = true
    piece.opacity = 1
    piece.depthWrite = false
    materialsMade++
    return piece
  }

  const acquireMaterial = (base: THREE.Material): PieceMaterial => {
    const free = pool.get(base)
    const m = free?.pop() ?? makePieceMaterial(base)
    // A pooled piece is lent back long after birth, and the base's defines are
    // edited in place at runtime (fragment gates, baked light).
    resyncClone(m, base, PIECE_STATE)
    m.opacity = 1
    return m
  }

  const releaseMaterial = (base: THREE.Material, m: PieceMaterial): void => {
    const free = pool.get(base)
    if (free) free.push(m)
    else pool.set(base, [m])
  }

  return {
    group,
    get live() {
      return pieces.length
    },
    get landed() {
      let n = 0
      for (const p of pieces) if (p.grounded) n++
      return n
    },
    get materialCount() {
      return materialsMade
    },
    prime(sources) {
      const warm: THREE.Mesh[] = []
      for (const s of sources) {
        // One per distinct PROP material. A second entry sharing a material
        // would warm a program that is already warm.
        if (pool.has(s.material)) continue
        const m = makePieceMaterial(s.material)
        releaseMaterial(s.material, m)
        // The prop's OWN geometry, not a chunk: the parameters that reach the
        // cache key are the attribute set (position / normal / color), and
        // `splitIntoChunks` copies exactly the attributes it was given. A
        // chunk here would mean splitting every palm at world build for a key
        // that is already decided.
        const mesh = new THREE.Mesh(s.geometry, m)
        mesh.name = 'props:fracture:warm'
        // Never drawn. `WebGLRenderer.compile` uses `traverse`, not
        // `traverseVisible`, for its materials — so this compiles and nothing
        // else in the frame changes.
        mesh.visible = false
        mesh.frustumCulled = false
        group.add(mesh)
        warm.push(mesh)
      }
      return {
        materials: warm.length,
        done() {
          for (const mesh of warm) group.remove(mesh)
          warm.length = 0
        },
      }
    },
    break(geometry, material, matrix, impact) {
      let chunks = cache.get(geometry.uuid)
      if (!chunks) {
        chunks = splitIntoChunks(geometry)
        cache.set(geometry.uuid, chunks)
      }
      matrix.decompose(pos, quat, scale)
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] as Chunk
        const m = acquireMaterial(material)
        const mesh = new THREE.Mesh(chunk.geometry, m)
        mesh.position.copy(pos)
        mesh.quaternion.copy(quat)
        mesh.scale.copy(scale)
        mesh.frustumCulled = false
        group.add(mesh)
        // Outward along the chunk's own direction, in the instance's frame,
        // plus a share of the ship's shove.
        dir.copy(chunk.direction).applyQuaternion(quat)
        const velocity = dir
          .clone()
          .multiplyScalar(OUTWARD_SPEED)
          .addScaledVector(impact, SHOVE_FRACTION)
        const spinAxis = new THREE.Vector3(dir.z, 0.3, -dir.x).normalize()
        pieces.push({
          mesh,
          material: m,
          base: material,
          velocity,
          spinAxis,
          spin: TUMBLE_RATE * (i % 2 === 0 ? 1 : -1),
          corners: chunk.corners,
          grounded: false,
          age: 0,
        })
      }
    },
    update(dt) {
      if (pieces.length === 0) return
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i] as Piece
        p.age += dt
        if (p.age >= seconds) {
          group.remove(p.mesh)
          // POOLED, not disposed (DEV-177). `material.dispose()` releases the
          // program, and the next break would compile it again in the seat —
          // which is the whole stall, arriving once per break instead of once
          // per run.
          releaseMaterial(p.base, p.material)
          pieces.splice(i, 1)
          continue
        }
        // A landed piece only fades. Nothing moves it, nothing re-queries the
        // ground, and it does not sink over the rest of its life.
        if (!p.grounded) {
          // Three space: gravity's y is the same axis, and there is no z flip
          // on a scalar down. The world's own −32, not Earth's.
          p.velocity.y += GRAVITY.y * dt
          p.mesh.position.addScaledVector(p.velocity, dt)
          spinQ.setFromAxisAngle(p.spinAxis, p.spin * dt)
          p.mesh.quaternion.premultiply(spinQ)
          // ── DEV-148: the hill is solid ─────────────────────────────────
          //
          // Tested AFTER the move, against the RENDERED surface the caller
          // handed in, with the piece's own box rather than its origin. On
          // contact it is lifted so the box's lowest corner sits exactly on
          // the ground and everything stops — a shard that landed. No bounce:
          // a bounce would have to be tuned and judged, and this is a thing
          // that is on screen for at most `seconds` while you fly past it.
          if (ground) {
            const floor = ground(p.mesh.position.x, p.mesh.position.z)
            const drop = dropBelowOrigin(p)
            if (p.mesh.position.y + drop <= floor) {
              p.mesh.position.y = floor - drop
              p.velocity.set(0, 0, 0)
              p.grounded = true
            }
          }
        }
        p.material.opacity = 1 - p.age / seconds
      }
    },
    dispose() {
      for (const p of pieces) {
        group.remove(p.mesh)
        p.material.dispose()
      }
      pieces.length = 0
      // The pool, and any warm mesh still hanging here. This is the ONE place
      // a piece material is disposed: the fracture is rebuilt at every course
      // swap, so its programs go with the world they were warmed for.
      for (const free of pool.values()) for (const m of free) m.dispose()
      pool.clear()
      for (const child of [...group.children]) group.remove(child)
      for (const chunks of cache.values()) for (const c of chunks) c.geometry.dispose()
      cache.clear()
    },
  }
}
