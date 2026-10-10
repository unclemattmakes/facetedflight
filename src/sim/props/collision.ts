// src/sim/props/collision.ts — the trees are solid, and they break. DEV-136.
//
// Matt, 2026-09-16: *"there are no collision with props — it'd be nice if
// they broke apart (the trees, cacti, etc)."*
//
// **This header used to say 2016 had neither, and that was wrong — DEV-214.**
// It read: *"the shipped scene's clones are LOD-toggled art under `Objects Root`
// and nothing on the ship reacted to them — you flew through the forest."* The
// premise is true and the conclusion does not follow.
// `FacetedTerrainObjectGenerator.Start()` deactivates `Objects Root` **only past
// `LODDistance`** — inside it the colliders are simply on — and `LODDistance` is
// **1280 on every shipped generator** where the C# initialiser says `300.0f`.
// Census with the liveness walk: alpine **6,069 of 6,069** live, desert **5,962
// of 5,989**, simonet 1 of 29, kauai 0 of 41. The ship's hull colliders are
// layer 25 `cockPit` and `m_LayerCollisionMatrix` word 25 has bit 0 set, the
// same word that makes the ship hit the ground.
//
// So 2016 collided and its rock STOOD: `Ship_HoverShip.OnCollisionEnter` ran
// `Flash()` — angular drag x3 for 0.3 s, `explode2`, gas and boost released —
// and nothing broke or moved. **What this module adds is therefore the RESPONSE,
// not the contact**: `breakSpeed` is the part with no 2016 counterpart, and
// `gameplay.propCollision.landmarks: false` would be a deviation rather than a
// return. This is Anniversary GAMEPLAY
// (`gameplay.propCollision`, §0.2's fenced block): a contact changes the
// trajectory, so a Classic run and an Anniversary run of the same stick
// diverge, and that is exactly what the fence exists to label.
//
// ── The shape ─────────────────────────────────────────────────────────────
//
// Every scattered prop is a VERTICAL CAPSULE: an axis from its base up its
// drawn height, a radius from its drawn width, both taken off the glTF bounds
// at scale 1 and multiplied by the placement scale — the same numbers the
// renderer composes, never a second estimate. A landmark's capsule is only the
// cheap reject: its shape is its mesh's convex hull (DEV-213) and, inside the
// hull, the mesh's own triangles (DEV-345, `landmark-mesh.ts`) — 2016's
// `MeshCollider` was `m_Convex: 0`. Everything sits in a spatial hash on a
// horizontal grid, so a tick costs the hull's five spheres × nine cells ×
// whatever stands there, which on alpine's 12,000 trees is tens of tests.
//
// **A hash whose walk is one cell wide can only hold colliders narrower than a
// cell**, and for four sessions this one held everything and reached most of
// it: desert's sixteen spires and Simonet's one have radii of 64.7–207.9 m
// against a 64 m cell, so they were in the structure, drawn on the screen, and
// not solid to anything. DEV-187 takes them off the hash and onto
// `oversized`, which every query tests directly.
//
// A contact is one of two things:
//
//   speed ≥ breakSpeed   the prop BREAKS: its collider is removed, a `propHit`
//                        with `broken: true` is reported, and the ship loses
//                        `breakSlowdown` of its speed — a tree costs you
//                        something and then it is gone.
//   speed <  breakSpeed  a BOUNCE: the hull is pushed out along the horizontal
//                        normal and the velocity into the prop is reflected by
//                        `bounceRestitution`; the prop stands.
//
// **And with `strike` on (DEV-428, Anniversary) the first branch STANDS too:**
// the ship pays the same slowdown and goes THROUGH, but the collider is kept,
// so the tree is solid to the next flier and to this one's next pass. The
// flier remembers what it is inside (`passing`) until its hull is clear. The
// renderer's rule follows the collider: a prop whose collider is gone is
// fractured (DEV-136), one that kept it bursts in its own colours.
//
// `propHit` is an EVENT on the state, cleared every tick, owned by the state
// (trap 19): the renderer swaps the instance for its fractured pieces, audio
// plays the strike, and DEV-126's crash-and-reset may later read `speed` for
// a very hard hit. Nothing here depends on that branch.
//
// ── Who collides: everything that flies (DEV-147) ─────────────────────────
//
// The player AND the AI racers, against ONE set of colliders — a tree a racer
// knocks down is down for you too. DEV-136 shipped this for the player alone
// and left the racers ghosting through the forest beside you, on the argument
// that a racer would "bounce off the forest on the lap the player is racing".
// Measured, that branch is unreachable for a racer: over a whole `int_01` run
// every one of the five tunings spends at least 99.65 % of its ticks at or
// above the preset's 45 m/s `breakSpeed`, so a racer that meets a tree breaks
// it. What each flier does NOT share is this state — `PropCollisionState` is
// per racer, because `hits` is read by the renderer after the step (trap 19).
//
// **That measurement was taken over the RACE, and the other 0.35 % is where it
// broke** (DEV-180): a racer that has finished throttles back to `minThrottle`
// and a crash-reset one arrives at `resetSpeed`, both below `breakSpeed`, so
// the bounce branch is the only one left to it and a palm becomes a wall it
// cannot get off. `breakHeldProps` is the escape, and it is the racer's alone.
//
// SIM LAYER: pure. No three, no DOM, no clock, no `Math.random`. Every number
// arrives in the spec; the two literals below are the 3×3 neighbourhood and
// the `radius * 2` that turns a radius into a diameter, and both are the
// definition of a spatial hash rather than a tuning — see `oversized`.

import type { Vec3 } from '../math/vec3'
import { v3 } from '../math/vec3'
import type { RigidBody } from '../rigidbody'
import { type HullSphere, hullSphereWorld } from '../terrain-collision'
import { buildLandmarkMesh, type LandmarkMesh, meshPenetration } from './landmark-mesh'

/** One prop's shape at scale 1, off the drawn glTF bounds. */
export interface PropShapeDims {
  /** Metres above the placement point the top sits, at scale 1. */
  readonly height: number
  /** Metres below the placement point the base sits (negative is buried), at scale 1. */
  readonly base: number
  /** Widest horizontal extent, at scale 1. */
  readonly width: number
}

/** The tuning, as the preset carries it. `gameplay.propCollision`. */
export interface PropCollisionSpec {
  /** m/s at or above which a contact breaks the prop instead of bouncing. */
  readonly breakSpeed: number
  /** Fraction of the ship's speed a break costs, 0..1. */
  readonly breakSlowdown: number
  /** How much of the velocity into a standing prop comes back out, 0..1. */
  readonly bounceRestitution: number
  /** Collider radius as a fraction of the prop's drawn width. */
  readonly radiusFraction: number
  /** Spatial hash cell, metres. About the widest collider is right. */
  readonly cellMetres: number
  /**
   * Seconds of UNBROKEN contact after which an AI racer breaks what it is
   * resting on, whatever its speed. 0 switches the rule off. DEV-180.
   *
   * `stepPropCollision` never reads this — `stepAiRacer` does, and the row it
   * belongs to is this one because the number is about the forest. See
   * {@link breakHeldProps} for why the racer needs it and the player does not.
   */
  readonly racerStuckSeconds: number
  /**
   * DEV-428: a struck prop STANDS. Absent or off is DEV-136 — a contact at or
   * above `breakSpeed` removes the collider for everybody.
   *
   * On: the collider is KEPT, the hitter pays `breakSlowdown` once and passes
   * THROUGH, and the prop is solid again to the next flier and to this one's
   * next pass. Matt, 2026-09-26, on a struck prop: *"stay standing"*. 2016's
   * rock stood too (DEV-214); what 2016 did not do was let you through it, and
   * that half of DEV-136 stays.
   *
   * Why the sim has to know: the renderer can leave a tree DRAWN on its own,
   * but a drawn tree with no collider is DEV-214's forest again — the racer
   * ahead strikes it, and you fly through the tree it leaves standing without
   * a touch. `passing` on the state is what lets a flier through a collider
   * that nobody removed.
   *
   * Plants only. A LANDMARK (a spire, with its own hull) struck at speed is
   * still removed — see `isLandmark` for why passing through a standing one
   * is not an answer.
   */
  readonly strike?: { readonly enabled: boolean } | null
}

/** What one contact reported. `id` indexes the colliders. */
export interface PropHit {
  readonly id: number
  readonly kind: string
  /** The ship's speed at contact, m/s. */
  readonly speed: number
  /** Contact point, SIM space. */
  readonly point: Vec3
  /** Horizontal unit normal from the prop axis to the hull, SIM space. */
  readonly normal: Vec3
  readonly broken: boolean
}

/**
 * Every collider, flat and shared with the renderer by index.
 *
 * SIM (Unity world) space: `x`/`z` are the axis, `bottom`/`top` the capsule's
 * vertical span, `radius` its radius. `broken` is the removed flag; a broken
 * collider stays in its cell and is skipped, so ids never move.
 */
export interface PropColliders {
  readonly count: number
  readonly x: Float32Array
  readonly z: Float32Array
  readonly bottom: Float32Array
  readonly top: Float32Array
  readonly radius: Float32Array
  readonly kind: string[]
  readonly broken: Uint8Array
  readonly cellMetres: number
  /** cell key → collider ids. Holds every id NOT in {@link PropColliders.oversized}. */
  readonly cells: Map<number, number[]>
  /**
   * The colliders the 3×3 walk cannot reach, tested directly by every query.
   * DEV-187, and the reason it has to exist is arithmetic:
   *
   * The walk visits the query point's cell and its eight neighbours, and a
   * collider is only ever in the cell of its own CENTRE — so the walk finds it
   * exactly when that centre is within one cell of the query point. A contact
   * needs the query point within `radius + sphereRadius` of the centre.
   * **The hash is therefore complete only while `radius + sphereRadius ≤
   * cellMetres`**, and silently, invisibly incomplete above it: a ship flies
   * through the collider and nothing anywhere reports a miss.
   *
   * `buildPropColliders` splits on `radius * 2 > cellMetres` — a collider whose
   * DIAMETER reaches a whole cell comes off the hash — which leaves the hash
   * correct for any query sphere up to half a cell. That is 32 m against the
   * 64 m cell the presets ship, and the widest sphere in either vehicle's hull
   * is 1.02 m. `prop-hash-reach.test.ts` holds it to a brute-force sweep.
   *
   * It is a LIST, not a wider walk, because of the shape of the data: seventeen
   * colliders in the whole port are oversized (desert's sixteen spires and
   * Simonet's one) against 19,285 that are not, and widening the walk to reach
   * a 207.9 m radius would be 81 cells a sphere a tick for every ship in every
   * environment. This is `oversized.length` extra tests, and on the ten
   * missions over alpine and kauai that is zero.
   */
  readonly oversized: number[]
  /**
   * Convex hulls, by collider id — `count * 4` floats of `nx, ny, nz, d` in SIM
   * world space, inside where `n·p <= d`. DEV-213.
   *
   * A MAP because it is sparse in the extreme: seventeen landmarks against
   * 19,285 scattered props, so an array of nulls would be 19,285 slots to hold
   * seventeen. A collider with a hull is tested against its PLANES and not
   * against its cylinder; `radius`/`bottom`/`top` stay as the cheap reject
   * that contains it, which is why {@link buildPropColliders} sizes a hull
   * collider's radius from the box's half-DIAGONAL rather than through
   * `radiusFraction`.
   */
  readonly hulls: Map<number, Float32Array>
  /**
   * The ROCK itself, by collider id — the triangles, binned. DEV-345.
   *
   * Behind the hull, never instead of it: a sphere the planes call clear is
   * clear of the rock by construction, so the triangles are read only by a
   * ship already inside a landmark's convex envelope. What they decide there
   * is the part DEV-213's hull got wrong in the one place it matters — a
   * concave rock's slack. Simonet's sea stack has a shoulder that
   * `int_01_jumpSeat`'s pad 5 is built on; the bullseye is 5.3 m clear of the
   * rock and was 22.4 m inside the hull, so nothing could land on it. 2016's
   * `MeshCollider` is `m_Convex: 0`, and this is that.
   */
  readonly meshes: Map<number, LandmarkMesh>
}

/**
 * How far OUTSIDE a convex hull a point is: <= 0 is inside, and the magnitude
 * is a lower bound on the distance to the surface.
 *
 * `max(n·p - d)` over the planes — the standard half-space test. Conservative
 * in the direction that matters: a point this calls outside is genuinely
 * outside every plane, so it is genuinely outside the hull.
 */
const hullGap = (planes: Float32Array, px: number, py: number, pz: number): number => {
  let worst = Number.NEGATIVE_INFINITY
  for (let i = 0; i < planes.length; i += 4) {
    const g =
      (planes[i] as number) * px +
      (planes[i + 1] as number) * py +
      (planes[i + 2] as number) * pz -
      (planes[i + 3] as number)
    if (g > worst) worst = g
  }
  return worst
}

export interface PropCollisionState {
  /** Contacts this tick. Cleared at the top of every step. */
  readonly hits: PropHit[]
  /** Colliders broken — or, with `strike`, struck — so far, for the console and the row. */
  brokenCount: number
  /**
   * DEV-428: the STANDING props this flier is inside because it struck them —
   * collider ids, per flier, never shared (trap 19; `hits` is the same rule).
   *
   * A contact with one of these is neither a hit nor a bounce: the flier paid
   * for the strike on the tick it went in, and it goes on through. An id leaves
   * the list on the first tick the hull no longer touches that prop, so the
   * next pass through the same tree is a strike again. Empty, and never
   * written, while `strike` is off.
   */
  readonly passing: number[]
}

export const createPropCollision = (): PropCollisionState => ({
  hits: [],
  brokenCount: 0,
  passing: [],
})

/** One placement to build a collider from. Mesh-space position plus the terrain origin. */
export interface PropPlacementInput {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly scale: number
  readonly dims: PropShapeDims
  readonly kind: string
  /**
   * A CONVEX HULL for this prop, `count * 4` floats — `nx, ny, nz, d` per plane,
   * inside where `n·p <= d`, in the PLACEMENT frame (sim, before `origin`).
   * Null or absent is the vertical cylinder, which is every scattered prop.
   *
   * DEV-213, and it is a fidelity move before it is a gameplay one:
   * **2016 collided on the MESH.** `Spire_B_w_Collision.prefab`'s two capsules
   * are `m_IsActive: 0` and its `MeshCollider` is `m_Enabled: 1`, so the
   * closest cheap approximation to what 2016 did is the tightest convex shape,
   * not a capsule of any arrangement. Measured over the seventeen landmarks,
   * claimed volume ÷ the rock's own volume: the shipped cylinder **1.58x**,
   * the hull **1.39x**, and a disc stack along the rod — 2016's two capsules
   * generalised — never better than **2.40x** at any slab count, because a
   * slab's cross-section is an irregular polygon and `pi r^2` on its
   * circumscribed radius overestimates it. Symmetry is what costs; the hull is
   * not symmetric.
   *
   * The 1.58x is a mean that hides the real defect: the cylinder is 0.8-1.0x
   * on the four upright spires, where it is SMALLER than the rock and a ship
   * flies through stone, and 2.6-3.1x on the leaning ones, where it is the
   * phantom wall `adv_01_hoverJet` flew 303 m of. Along the authored lines the
   * hull takes phantom metres from 935 to 279 and rock missed from 260 to 0.
   */
  readonly hull?: Float32Array | null
  /**
   * The drawn TRIANGLES, `count * 9` floats in the PLACEMENT frame (sim,
   * before `origin`). Null or absent is no mesh. DEV-345: a collider that
   * carries one is decided by it wherever {@link hull} says the sphere is
   * inside — see {@link PropColliders.meshes}.
   */
  readonly mesh?: Float32Array | null
}

const cellKey = (cx: number, cz: number): number => cx * 73856093 + cz * 19349663

/**
 * Build the colliders. `origin` is the terrain's origin in SIM space (the
 * height field carries it), so the mesh-space placements come out where the
 * ship actually flies. Deterministic: same input, same arrays.
 */
export const buildPropColliders = (
  placements: readonly PropPlacementInput[],
  origin: { readonly x: number; readonly y: number; readonly z: number },
  spec: PropCollisionSpec,
): PropColliders => {
  const n = placements.length
  const x = new Float32Array(n)
  const z = new Float32Array(n)
  const bottom = new Float32Array(n)
  const top = new Float32Array(n)
  const radius = new Float32Array(n)
  const kind: string[] = new Array(n)
  const cells = new Map<number, number[]>()
  const oversized: number[] = []
  const hulls = new Map<number, Float32Array>()
  const meshes = new Map<number, LandmarkMesh>()
  for (let i = 0; i < n; i++) {
    const p = placements[i] as PropPlacementInput
    x[i] = p.x + origin.x
    z[i] = p.z + origin.z
    bottom[i] = p.y + origin.y + p.dims.base * p.scale
    top[i] = p.y + origin.y + p.dims.height * p.scale
    // A hull collider's cylinder is a cheap REJECT and has to contain the
    // hull, so it is the box's half-diagonal rather than `radiusFraction` of
    // its width: `width` is the larger of the two horizontal extents, so
    // `width * SQRT1_2` bounds a `dx x dz` box about its own centre. Shrinking
    // it by a fraction, as the scatter does, would reject contacts the planes
    // would have found — the DEV-187 failure in a new place.
    radius[i] = p.dims.width * p.scale * (p.hull || p.mesh ? Math.SQRT1_2 : spec.radiusFraction)
    kind[i] = p.kind
    if (p.hull && p.hull.length > 0) {
      // Planes arrive in the PLACEMENT frame; `n·(s - origin) <= d` is
      // `n·s <= d + n·origin`. Copied rather than mutated: the input belongs
      // to the caller, and `buildPropColliders` is documented deterministic.
      const shifted = new Float32Array(p.hull.length)
      for (let k = 0; k < p.hull.length; k += 4) {
        const nx = p.hull[k] as number
        const ny = p.hull[k + 1] as number
        const nz = p.hull[k + 2] as number
        shifted[k] = nx
        shifted[k + 1] = ny
        shifted[k + 2] = nz
        shifted[k + 3] = (p.hull[k + 3] as number) + nx * origin.x + ny * origin.y + nz * origin.z
      }
      hulls.set(i, shifted)
    }
    if (p.mesh && p.mesh.length >= 9) {
      // Same shift, applied to the points rather than to a plane offset.
      const shifted = new Float32Array(p.mesh.length)
      for (let k = 0; k < p.mesh.length; k += 3) {
        shifted[k] = (p.mesh[k] as number) + origin.x
        shifted[k + 1] = (p.mesh[k + 1] as number) + origin.y
        shifted[k + 2] = (p.mesh[k + 2] as number) + origin.z
      }
      meshes.set(i, buildLandmarkMesh(shifted))
    }
    // DEV-187. The reach rule, and the whole of it is in `oversized`'s doc: a
    // collider as wide across as a cell cannot be found by a walk that only
    // ever looks one cell out, so it does not go in the hash at all.
    if ((radius[i] as number) * 2 > spec.cellMetres) {
      oversized.push(i)
      continue
    }
    const k = cellKey(
      Math.floor((x[i] as number) / spec.cellMetres),
      Math.floor((z[i] as number) / spec.cellMetres),
    )
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  return {
    count: n,
    x,
    z,
    bottom,
    top,
    radius,
    kind,
    broken: new Uint8Array(n),
    cellMetres: spec.cellMetres,
    cells,
    oversized,
    hulls,
    meshes,
  }
}

/**
 * Past the cylinder reject: how deep a sphere is in collider `id`'s SHAPE,
 * <= 0 clear. The ONE spelling of it, for the step and the query alike.
 *
 * A scattered prop's shape is its cylinder, so `cylinder` — the reject's own
 * `r + sphere.radius - d` — is already the answer. A landmark's is decided by
 * its hull's planes (DEV-213) and, where they say inside, by its triangles
 * (DEV-345): the planes are exact about OUTSIDE and only a bound about inside,
 * and the triangles are the rock.
 */
const shapePenetration = (
  props: PropColliders,
  id: number,
  px: number,
  py: number,
  pz: number,
  sphereRadius: number,
  cylinder: number,
): number => {
  const planes = props.hulls.get(id)
  const mesh = props.meshes.get(id)
  if (planes) {
    const hull = sphereRadius - hullGap(planes, px, py, pz)
    if (hull <= 0 || !mesh) return hull
  }
  return mesh ? meshPenetration(mesh, px, py, pz, sphereRadius) : cylinder
}

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _world = v3()
/**
 * The candidate lists one hull sphere tests: the nine cells, then `oversized`.
 *
 * Gathered rather than iterated in place so that the contact test below is
 * written ONCE. Two spellings of one test are two devices of our own agreeing
 * with each other until they do not, which is the mistake `propPenetrationAt`'s
 * doc-comment already names — and here the second spelling would be the branch
 * that only ever runs beside a spire, i.e. the one nothing exercises.
 * Reused, never stored (trap 19): `length = 0` keeps the capacity.
 */
const _lists: (readonly number[])[] = []
/**
 * DEV-428: the `passing` ids the hull touched THIS tick. Scratch, valid only
 * inside one `stepPropCollision` — the per-flier memory is `state.passing`,
 * and this only decides what survives in it (trap 19).
 */
const _touching: number[] = []

/**
 * Fill `out` with every candidate list for a query at `(px, pz)`: the nine
 * hash cells around it, then the oversized colliders the hash cannot hold.
 */
const candidateLists = (
  out: (readonly number[])[],
  props: PropColliders,
  px: number,
  pz: number,
): void => {
  out.length = 0
  const cx = Math.floor(px / props.cellMetres)
  const cz = Math.floor(pz / props.cellMetres)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = props.cells.get(cellKey(cx + dx, cz + dz))
      if (list) out.push(list)
    }
  }
  if (props.oversized.length > 0) out.push(props.oversized)
}

/**
 * Is collider `id` a LANDMARK — a rock with its own hull or triangles (DEV-213,
 * DEV-345) rather than a scattered plant's cylinder?
 *
 * DEV-428 lets a flier through a struck prop that stands, and that is right
 * for what the scatter is — palms, bushes, cacti, trees: every scatter kind in
 * the four environments is a plant. It is not right for the seventeen spires,
 * whose colliders run 65-208 m across: going THROUGH one that stands puts the
 * eye inside stone for a second or more. So a landmark struck at speed keeps
 * DEV-136's response, removed and fractured, until the question of what a
 * standing rock should do instead is answered (the DEV-428 row asks it).
 * Structural rather than by name: the shape a collider carries is what makes
 * it a rock here, which is the same test `shapePenetration` makes.
 */
const isLandmark = (props: PropColliders, id: number): boolean =>
  props.hulls.has(id) || props.meshes.has(id)

/**
 * DEV-502: take a collider out of the world because a course's clearing HID
 * its prop (`cleared`), or put it back when the clearing moves off it.
 *
 * The second place `broken` is written, and the only one that clears it —
 * because a cleared prop is exactly a broken one to every query: not drawn,
 * and not there (DEV-136's rule, a collider whose mesh is not drawn is a
 * bug). It is not a BREAK: nothing is counted and no strike is paid. The
 * caller (`game/props/course-clearing.ts`'s mask) never clears or restores an
 * id a flier broke, so the two writers never contend for one collider.
 */
export const setPropCleared = (props: PropColliders, id: number, cleared: boolean): void => {
  if (id >= 0 && id < props.count) props.broken[id] = cleared ? 1 : 0
}

/** Remove a collider and count it. The one place a flier writes `broken`. */
const breakCollider = (state: PropCollisionState, props: PropColliders, id: number): void => {
  props.broken[id] = 1
  state.brokenCount++
}

/**
 * Break everything this tick's contacts are STANDING on, whatever the speed.
 * Returns how many it removed. DEV-180.
 *
 * ── Why this exists, and why only a racer calls it ────────────────────────
 *
 * DEV-147's decision to give the racers BREAK rather than AVOID was measured:
 * *"over a whole `int_01` run every one of the five tunings spends at least
 * 99.65 % of its ticks at or above the preset's 45 m/s `breakSpeed`"*, so the
 * bounce branch was the one a racer essentially cannot reach. **That
 * measurement was taken over the RACE.** The other 0.35 % is the fly-out and
 * the crash reset, and both of them are under `breakSpeed` by construction: the
 * fly-out throttles back to `minThrottle` (31.4 m/s on `fast` and `cutter`,
 * 44.9 on `steady` and `cruiser` — four of the five tunings can never break a
 * prop again once they finish), and a reset arrives at `crash.resetSpeed` 40
 * with the engine cold. A racer in either state that meets a palm is in the one
 * branch it cannot leave: the prop is unbreakable FOR THAT RACER, the bounce
 * pushes it out, the controller flies it back in, and the pair runs as a limit
 * cycle. Measured: 157 contacts in 1.9 s off one palm, the speed collapsing
 * 39.5 → 9.9 m/s in a single tick because two hull spheres touch at once.
 *
 * So this is not a new rule, it is DEV-147's own rule reaching the regime its
 * measurement missed — and the escape is the one a player already understands,
 * because a tree falls.
 *
 * The PLAYER does not call it. Below `breakSpeed` a player's drift into a trunk
 * is supposed to glance (DEV-136, Matt's numbers), a player can let go of the
 * stick, and a player is never in a state that forbids the break branch for the
 * rest of the run. Changing that is a design call and not this one's to make.
 *
 * The velocity is NOT touched: `breakSlowdown` is what a break at racing speed
 * costs, and taking 6 % off a ship doing 2 m/s would be arithmetic for its own
 * sake. The point is to free it.
 *
 * **It REMOVES the collider even with `strike` on (DEV-428).** A stuck racer is
 * the one contact where "let this flier through" cannot be told from "pushed
 * off it": the bounce this tick has just depenetrated the hull to the surface,
 * so a `passing` entry could be pruned on the next tick before the controller
 * flies it back in, and the grind would start again. Taking the collider away
 * is DEV-180's measured escape, kept exactly; the renderer then fractures that
 * one tree rather than leave a drawn tree nobody can touch.
 */
export const breakHeldProps = (state: PropCollisionState, props: PropColliders): number => {
  let broke = 0
  for (let i = 0; i < state.hits.length; i++) {
    const hit = state.hits[i] as PropHit
    if (hit.broken || props.broken[hit.id]) continue
    breakCollider(state, props, hit.id)
    // The renderer swaps the instance for its pieces off `broken`, so the
    // contact it already reported has to become the break it now is — a second
    // hit for the same id would fracture the same trunk twice.
    state.hits[i] = { ...hit, broken: true }
    broke++
  }
  return broke
}

/**
 * Test the hull against the props and resolve what it hits. Call AFTER the
 * flight model and the terrain have moved the body.
 *
 * Returns the number of contacts this tick. Each contact is pushed onto
 * `state.hits` — a fresh object per hit, never a scratch.
 */
export const stepPropCollision = (
  state: PropCollisionState,
  body: RigidBody,
  hull: readonly HullSphere[],
  props: PropColliders,
  spec: PropCollisionSpec,
): number => {
  state.hits.length = 0
  const v = body.velocity
  const speed = Math.hypot(v.x, v.y, v.z)
  // DEV-428. Read per tick off the live spec, like `breakSpeed`: a preset flip
  // mid-run is honoured on the next contact.
  const standing = spec.strike?.enabled === true
  _touching.length = 0

  for (const sphere of hull) {
    hullSphereWorld(
      _world,
      body.position.x,
      body.position.y,
      body.position.z,
      body.orientation,
      sphere,
    )
    const px = _world.x
    const py = _world.y
    const pz = _world.z

    candidateLists(_lists, props, px, pz)
    for (let li = 0; li < _lists.length; li++) {
      const list = _lists[li] as readonly number[]
      for (const id of list) {
        if (props.broken[id]) continue
        const r = props.radius[id] as number
        // Vertical span first: cheap, and most of a forest is under the ship.
        if (py + sphere.radius < (props.bottom[id] as number)) continue
        if (py - sphere.radius > (props.top[id] as number)) continue
        const ox = px - (props.x[id] as number)
        const oz = pz - (props.z[id] as number)
        const d = Math.hypot(ox, oz)
        let penetration = r + sphere.radius - d
        if (penetration <= 0) continue
        // Past the cheap reject, a landmark is decided by its hull and then its
        // rock (DEV-213, DEV-345). The cylinder above only bounds it.
        penetration = shapePenetration(props, id, px, py, pz, sphere.radius, penetration)
        if (penetration <= 0) continue

        // DEV-428: already going through it. No hit, no bounce, no second
        // slowdown — just remembered as touched, so it stays passable until
        // the hull is out of it.
        if (standing && state.passing.includes(id)) {
          if (!_touching.includes(id)) _touching.push(id)
          continue
        }

        // Horizontal normal from the axis to the hull. Straight down the
        // axis is a degenerate case; pick +x rather than divide by zero.
        // Radial even for a hull: the RESPONSE is DEV-136's and is horizontal
        // by construction, and taking the violated plane's normal instead
        // would change how a contact feels as well as where it happens. This
        // row moved the shape and deliberately not the response.
        const nx = d > 1e-6 ? ox / d : 1
        const nz = d > 1e-6 ? oz / d : 0
        const broken = speed >= spec.breakSpeed
        state.hits.push({
          id,
          kind: props.kind[id] as string,
          speed,
          point: v3(px - nx * sphere.radius, py, pz - nz * sphere.radius),
          normal: v3(nx, 0, nz),
          broken,
        })

        if (broken) {
          if (standing && !isLandmark(props, id)) {
            // DEV-428: the prop stands and keeps its collider; THIS flier is let
            // through it. `brokenCount` still counts it — a strike is the event
            // the console and the row were counting.
            state.passing.push(id)
            _touching.push(id)
            state.brokenCount++
          } else {
            breakCollider(state, props, id)
          }
          const keep = 1 - spec.breakSlowdown
          v.x *= keep
          v.y *= keep
          v.z *= keep
        } else {
          // Push out, then reflect the velocity into the prop. Positional
          // depenetration, like the terrain's: an impulse alone jitters.
          body.position.x += nx * penetration
          body.position.z += nz * penetration
          const into = v.x * nx + v.z * nz
          if (into < 0) {
            const scale = -(1 + spec.bounceRestitution) * into
            v.x += nx * scale
            v.z += nz * scale
          }
        }
      }
    }
  }
  // DEV-428: a prop the hull no longer touches is no longer being passed — the
  // next contact with it is a strike again. In place, keeping the order, and
  // ALWAYS run: with `strike` off nothing is touched, so a list left over from
  // a preset flip empties on the first tick instead of lingering.
  let kept = 0
  for (let i = 0; i < state.passing.length; i++) {
    const id = state.passing[i] as number
    if (_touching.includes(id)) state.passing[kept++] = id
  }
  state.passing.length = kept
  return state.hits.length
}

/** Scratch for the query below. Its own set — never the step's (trap 19). */
const _qWorld = v3()
const _qLists: (readonly number[])[] = []

/**
 * How deep would this hull be inside a STANDING prop, at this pose?
 *
 * Zero is clear; a positive number is the depenetration `stepPropCollision`
 * would apply on the deepest contact. A QUERY: it moves nothing, reports
 * nothing and breaks nothing.
 *
 * It exists so a rule that has to AVOID the props — DEV-185's crash reset — can
 * ask the question the contact will answer later, and it walks the same nine
 * hash cells, rotates the hull by the same `rotateVec3`, skips the same broken
 * colliders and computes the same `r + sphere.radius - d`. Two spellings of one
 * test would be two devices of our own agreeing with each other until they did
 * not; `props-collision.test.ts` asserts they never disagree on a pose.
 */
export const propPenetrationAt = (
  position: Vec3,
  orientation: { readonly x: number; readonly y: number; readonly z: number; readonly w: number },
  hull: readonly HullSphere[],
  props: PropColliders,
): number => {
  let worst = 0
  for (const sphere of hull) {
    hullSphereWorld(_qWorld, position.x, position.y, position.z, orientation, sphere)
    const px = _qWorld.x
    const py = _qWorld.y
    const pz = _qWorld.z
    candidateLists(_qLists, props, px, pz)
    for (let li = 0; li < _qLists.length; li++) {
      const list = _qLists[li] as readonly number[]
      for (const id of list) {
        if (props.broken[id]) continue
        if (py + sphere.radius < (props.bottom[id] as number)) continue
        if (py - sphere.radius > (props.top[id] as number)) continue
        const ox = px - (props.x[id] as number)
        const oz = pz - (props.z[id] as number)
        let penetration = (props.radius[id] as number) + sphere.radius - Math.hypot(ox, oz)
        if (penetration <= 0) continue
        penetration = shapePenetration(props, id, px, py, pz, sphere.radius, penetration)
        if (penetration > worst) worst = penetration
      }
    }
  }
  return worst
}

// ── DEV-503: which props a SEGMENT comes within reach of ─────────────────

/** One collider a segment passes within reach of, SIM space. */
export interface PropNear {
  readonly id: number
  readonly kind: string
  /**
   * How far inside `reach` of the collider's SHAPE the segment comes, metres,
   * above zero: the depth a sphere of radius `reach` swept along the segment
   * reaches into it, `propPenetrationAt`'s own measure.
   */
  readonly depth: number
  /** The collider's axis at the height the segment passes it (clamped to its span). */
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * Every live collider a sphere of radius `reach`, swept along the segment
 * a→b, would touch — each once, with how deep. DEV-503, the editor's
 * `line-through-prop` and `ring-in-prop`, asked of the world's LIVE set: a
 * broken or cleared (DEV-502) collider is not there.
 *
 * The same shape the step and `propPenetrationAt` test, not a second idea of
 * one: a scattered prop is its cylinder (`radius`, `bottom … top`) grown by
 * the sphere, so the segment is CLIPPED to the band `bottom − reach … top +
 * reach` and its plan distance to the axis decides; a landmark is decided by
 * `shapePenetration` (its hull's planes, then its triangles) at points along
 * the clipped segment. Those points are `reach / 2` apart, plus the one
 * nearest the axis — a sampling, so a landmark's depth is never overstated and
 * falls short of the swept truth by at most what half a reach of spacing
 * costs (`editor-props-warning.test.ts` holds it to a dense sweep).
 *
 * The hash is walked over the segment's plan box grown by `reach` and half a
 * cell, the furthest a hashed collider's centre can stand from a point it
 * touches (`oversized`'s doc: a hashed collider is at most half a cell
 * across), and `oversized` is tested whole. A collider lives in one cell or
 * on `oversized`, never both, so nothing is reported twice.
 */
export const propsNearSegment = (
  props: PropColliders,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  reach: number,
): PropNear[] => {
  const out: PropNear[] = []
  if (!(reach >= 0)) return out
  const ex = bx - ax
  const ey = by - ay
  const ez = bz - az
  const test = (id: number): void => {
    if (props.broken[id]) return
    const lo = (props.bottom[id] as number) - reach
    const hi = (props.top[id] as number) + reach
    // The segment's parameter range inside the collider's vertical band.
    let t0 = 0
    let t1 = 1
    if (Math.abs(ey) < 1e-12) {
      if (ay < lo || ay > hi) return
    } else {
      const ta = (lo - ay) / ey
      const tb = (hi - ay) / ey
      t0 = Math.max(0, Math.min(ta, tb))
      t1 = Math.min(1, Math.max(ta, tb))
      if (t0 > t1) return
    }
    const cx = props.x[id] as number
    const cz = props.z[id] as number
    const r = props.radius[id] as number
    // The plan point of the clipped segment nearest the axis.
    const len2 = ex * ex + ez * ez
    let u = len2 > 0 ? ((cx - ax) * ex + (cz - az) * ez) / len2 : t0
    u = Math.min(t1, Math.max(t0, u))
    const cylinder = r + reach - Math.hypot(ax + u * ex - cx, az + u * ez - cz)
    if (cylinder <= 0) return
    let depth = cylinder
    let at = u
    if (props.hulls.has(id) || props.meshes.has(id)) {
      // A landmark: its shape, at points along the clipped segment.
      depth = 0
      const span = Math.hypot(ex, ey, ez) * (t1 - t0)
      const n = Math.max(1, Math.ceil(span / Math.max(reach / 2, 1e-3)))
      const sample = (t: number): void => {
        const sx = ax + t * ex
        const sy = ay + t * ey
        const sz = az + t * ez
        const c = r + reach - Math.hypot(sx - cx, sz - cz)
        if (c <= 0) return
        const d = shapePenetration(props, id, sx, sy, sz, reach, c)
        if (d > depth) {
          depth = d
          at = t
        }
      }
      sample(u)
      for (let k = 0; k <= n; k++) sample(t0 + ((t1 - t0) * k) / n)
      if (depth <= 0) return
    }
    const y = Math.min(props.top[id] as number, Math.max(props.bottom[id] as number, ay + at * ey))
    out.push({ id, kind: props.kind[id] as string, depth, x: cx, y, z: cz })
  }
  const grow = reach + props.cellMetres / 2
  const x0 = Math.floor((Math.min(ax, bx) - grow) / props.cellMetres)
  const x1 = Math.floor((Math.max(ax, bx) + grow) / props.cellMetres)
  const z0 = Math.floor((Math.min(az, bz) - grow) / props.cellMetres)
  const z1 = Math.floor((Math.max(az, bz) + grow) / props.cellMetres)
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const list = props.cells.get(cellKey(cx, cz))
      if (list) for (const id of list) test(id)
    }
  }
  for (const id of props.oversized) test(id)
  return out
}
