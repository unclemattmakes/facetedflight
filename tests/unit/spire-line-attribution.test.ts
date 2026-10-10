// tests/unit/spire-line-attribution.test.ts — is the capsule rock, or air? DEV-213.
//
// DEV-196 put the seventeen hand-placed landmarks where 2016 has them, which
// moved every spire 238–684 m. Anniversary's prop-collision capsules follow the
// drawn rock (DEV-136 / DEV-187), so the authored racing lines now pass through
// different stretches of capsule — and on `int_01_hoverJet`, the ONE mission of
// the first public release, 70 m of the authored line is inside the Simonet sea
// stack's capsule at up to 8.6 m deep.
//
// **That is a claim about a CAPSULE and the gameplay question is about a ROCK.**
// A landmark's collider is a vertical cylinder sized off the drawn box: radius
// `width × radiusFraction`, spanning the box bottom to the box top. DEV-187 §4
// measured 31–68 % of a spire's own vertices inside its own capsule, so the
// rest of that volume is air the rock does not occupy — and a LEANING rod is
// the worst case for it, because then the drawn box's width is the rod's
// LENGTH and the capsule is a disc. DEV-187 (b′) had to separate exactly these
// two claims once already: `adv_01_hoverJet` read 336 m inside a spire and the
// rock was not there (0 of 64 bearings, no vertex within 25 m).
//
// (b′) settled it with a bearing sweep, which answers *is this inside the
// horizontal footprint*. This file asks the exact question — **is this point
// inside the mesh, and how far is the hull from the nearest triangle** —
// through `helpers/prop-mesh.ts`, which reads the triangles the renderer draws
// through the matrix the renderer draws them with and consults `PropColliders`
// for nothing. CLAUDE.md's rule: compare against something outside the port,
// and here the mesh is outside the part of the port under test.
//
// ── What it found, and what changed because of it ───────────────────────
//
// **`int_01_hoverJet` never needed a decision.** Its contact with the sea stack
// sits **335 m past the finish volume**, in the kilometre of `CurvyClonePath`
// that runs on after the course ends; the ring-to-ring chord clears the rock by
// **490 m** and the nearest ring centre by 492 m. Nothing on the release
// mission's racing line touches a landmark at all.
//
// **The defect was the other way round, and the shape was wrong in BOTH
// directions at once.** Claimed volume ÷ the rock's own volume, analytic on
// both sides: the shipped vertical cylinder averaged **1.58x**, but that mean
// hides everything — **0.8-1.0x** on the four upright spires, where it is
// SMALLER than the rock and a ship flies through stone, and **2.6-3.1x** on the
// leaning ones, where it is a wall made of nothing. `adv_01_hoverJet` flew
// **303 m of raced line** inside a capsule that was **0 % rock**, the worst
// point 117.7 m from the nearest triangle.
//
// **So the shape changed to the mesh's CONVEX HULL** (`landmarkHullPlanes`,
// DEV-213), which is 1.39x and CONTAINS the rock. Matt asked for colliders
// closer to the mesh than a rod; the hull is the answer and the negative result
// is what makes it convincing. A disc stack along the rod's own axis — 2016's
// two hand-placed capsules generalised to K slabs — never gets below **2.40x**
// at any K, because refining a rotationally symmetric shape refines it ALONG
// the axis while the loss is ACROSS it. And the fidelity argument runs the same
// way: the prefab's two capsules are `m_IsActive: 0` and its `MeshCollider` is
// live, so **2016 collided on the MESH** and the hull is the closest cheap
// approximation to that. Every capsule variant is further from 2016, not nearer.
//
// Along the authored lines, phantom metres **935 -> 279** and rock missed
// **260 -> 0**.
//
// ── What it gates ─────────────────────────────────────────────────────────
//
// Not the numbers, which are content and are Matt's — DEV-213's row has the
// call and `docs/plan/SPIRE-COLLISION-CALL.md` the working. These, which are
// not opinions, and they fail in different directions on purpose:
//
//   1. the ORACLE is sound — the meshes are closed enough for ray parity to
//      mean something, a point known to be deep inside reads inside, and a
//      point a kilometre away reads outside;
//   2. the ROD FIT is 2016's — the fitted principal axis agrees with the two
//      hand-placed Unity capsules to 3.4-4.2° on all thirteen live `Spire_B`
//      instances, which is a check from outside the port on a device of this
//      file's own;
//   3. the PAIRING is real — collider id `k` really is the landmark whose mesh
//      is being asked about, rebuilt through `landmarkColliderInput` rather
//      than assumed from the append order;
//   4. **NO ROCK IS MISSED** on any line. The containment the hull has by
//      construction, checked after the trip through the z-mirror, the origin
//      shift and the hash — the places a sign or a frame could quietly undo it;
//   5. **`adv_01_hoverJet` has no landmark contact at all** — the phantom wall
//      is gone and stays gone;
//   6. `int_01_hoverJet` meets no landmark before its finish, and where it does
//      meet one it is mostly rock. Not 100 %: a convex hull round a concave
//      rock has slack, and 36 m of the 184 is that rather than a misplaced
//      collider.
//
// The tables it prints are the measurement the ledger row quotes.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import type { PropLandmark } from '@/content/load-environment'
import { terrainOriginSim } from '@/game/mission-shape'
import {
  drawnBoxOfVertices,
  landmarkColliderInput,
  landmarkMatrixOf,
} from '@/game/props/load-props'
import { environmentTerrains, terrainLocalPosition } from '@/game/terrain/load-terrain'
import { gateArcLengths } from '@/sim/ai-racer'
import type { Gate } from '@/sim/course'
import { v3 } from '@/sim/math/vec3'
import type { PropColliders, PropCollisionSpec } from '@/sim/props/collision'
import { type Route, routeAt } from '@/sim/route'
import { HOVERJET_GROUND } from '@/sim/terrain-collision'
import anniversary from '../../content/editions/anniversary.json'
import { shippedChord, shippedCrashLine } from './helpers/crash-line'
import {
  drawnLandmarksFor,
  envLandmarks,
  forestFor,
  glbShapeOf,
  haveForest,
  propContactsBrute,
} from './helpers/prop-forest'
import {
  convexHullOf,
  type DiscStack,
  discStackOf,
  discStackVolume,
  distanceToMesh,
  distanceToRod,
  gapToDiscStack,
  gapToHull,
  type HullPlanes,
  hullVolume,
  insideMesh,
  meshVolume,
  type PropMesh,
  propMeshOf,
  type Rod,
  rodOf,
  watertightFraction,
} from './helpers/prop-mesh'
import { fieldFor, loadLevelJson, MISSIONS } from './helpers/terrain-field'

const EDITION = anniversary as unknown as {
  gameplay: { propCollision: PropCollisionSpec }
  props: {
    scale: Record<string, unknown>
    unbakedPasses: { enabled: boolean }
    groundSnap: { enabled: boolean; sink: number }
    maxSlope: { enabled: boolean; sin: number }
  }
}
const SPEC = EDITION.gameplay.propCollision
const HULL = HOVERJET_GROUND.collision.hull
const LEVEL = { x: 0, y: 0, z: 0, w: 1 }

const FOREST_OPTIONS = {
  spec: SPEC,
  scale: EDITION.props.scale,
  unbakedPasses: EDITION.props.unbakedPasses.enabled,
  groundSnapSink: EDITION.props.groundSnap.enabled ? EDITION.props.groundSnap.sink : null,
  maxSlope: EDITION.props.maxSlope.enabled ? EDITION.props.maxSlope.sin : null,
  landmarks: true,
}

/**
 * Slabs in a landmark's disc stack. Eight is where the ladder in
 * `spire-line-attribution.test.ts` stops paying — see that test's table.
 */
const LANDMARK_SLABS = 8

const SPIRE_ASSETS = [
  'assets/props/spire-b.glb',
  'assets/props/spire-c.glb',
  'assets/props/spire-d.glb',
] as const

/** The crash rule's line: the one the game builds (`helpers/crash-line.ts`). */
// biome-ignore lint/suspicious/noExplicitAny: the level JSON arrives untyped, as everywhere in this folder
const crashLineOf = (level: any): Route => shippedCrashLine(level as Level).route

/**
 * The straight-line path from the spawn through every ring centre — the path a
 * PLAYER takes, as opposed to 2016's authored spline.
 *
 * Both matter and they are different questions. `level.route` is 2016's own
 * `CurvyClonePath` (22 control points, granularity 20 — the curve
 * `SplinePathCloneBuilder` placed the rings along), so a rock on it is a rock
 * 2016 drew the course through. But nothing makes a player follow a curve: the
 * rings are the constraint, and the shortest legal path between two of them is
 * the chord. A rock on the spline and off the chord is scenery to fly round; a
 * rock on both is in the way whatever you do.
 */
// biome-ignore lint/suspicious/noExplicitAny: same
const gateLineOf = (level: any): Route => shippedChord(level as Level)

/**
 * Arc length of the point on `route` nearest the mission's FINISH volume, or 0
 * when it has none.
 *
 * Every shipped mission carries one (`level.finish`), it is what actually ends
 * a run, and on `int_01_hoverJet` it sits PAST the final ring — so bounding the
 * raced line at the last ring alone would be the convenient reading rather
 * than the true one. `ghosts.ts` and `racers.ts` both take the centre as
 * `(pos[0], pos[1], -pos[2])`; this does the same.
 */
// biome-ignore lint/suspicious/noExplicitAny: the level JSON arrives untyped
const finishArc = (route: Route, level: any): number => {
  const f = level.finish as { pos: number[]; radius: number } | null | undefined
  if (!f) return 0
  const c = {
    x: f.pos[0] as number,
    y: f.pos[1] as number,
    z: -(f.pos[2] as number),
  }
  const at = v3()
  let best = Number.POSITIVE_INFINITY
  let bestS = 0
  for (let s = 0; s <= route.length; s += 1) {
    routeAt(route, s, at)
    const d = Math.hypot(at.x - c.x, at.y - c.y, at.z - c.z)
    if (d < best) {
      best = d
      bestS = s
    }
  }
  return bestS
}

interface LandmarkEntry {
  readonly name: string
  readonly mesh: PropMesh
  readonly rod: Rod
}

/**
 * Every live landmark of an environment as a drawn MESH and a fitted ROD, keyed
 * by the collider id `forestFor` gave it.
 *
 * The ids line up because `forestFor` appends the landmarks after the scatter
 * in `env.landmarks` order, exactly as `load-props.ts`'s `colliderInputs` does,
 * and this walks the same filtered list in the same order. **Checked, not
 * assumed** — if the order ever diverges every mesh below would be compared
 * against the wrong rock, and the answer would look like a fact about geometry.
 */
const landmarkEntries = (
  environment: string,
  field: { originX: number; originY: number; originZ: number },
  props: PropColliders,
  missionProps: readonly PropLandmark[] | null = null,
): Map<number, LandmarkEntry> => {
  const local = terrainLocalPosition(environmentTerrains(environment).land)
  // DEV-218 / DEV-219: through the RENDERER's own filter, which is also what
  // `forestFor` appends. Not concatenated here: DEV-218a drops a mission prop
  // coincident with one the environment already draws, and a second copy of the
  // join would pair every mesh below with the wrong rock the moment it fired —
  // which is exactly what gate (3), the pairing check, exists to catch.
  const landmarks = drawnLandmarksFor(environment, missionProps)
  const out = new Map<number, LandmarkEntry>()
  let id = props.count - landmarks.length
  for (const l of landmarks) {
    const m = new THREE.Matrix4()
    landmarkMatrixOf(l, local, m)
    const g = glbShapeOf(l.meshAsset as string)
    const input = landmarkColliderInput(
      l,
      drawnBoxOfVertices(new THREE.BufferAttribute(g.verts(), 3), m),
      m,
    )
    expect(
      input.x + field.originX,
      `${environment} ${l.name}: collider ${id} is not this landmark's`,
    ).toBeCloseTo(props.x[id] as number, 2)
    expect(
      input.z + field.originZ,
      `${environment} ${l.name}: collider ${id} is not this landmark's`,
    ).toBeCloseTo(props.z[id] as number, 2)
    const mesh = propMeshOf(l.meshAsset as string, m)
    out.set(id, { name: l.name, mesh, rod: rodOf(mesh) })
    id++
  }
  return out
}

/** SIM (Unity world) → THREE world, the frame the landmark meshes are in. */
const simToThree = (
  p: { x: number; y: number; z: number },
  field: { originX: number; originY: number; originZ: number },
): { x: number; y: number; z: number } => ({
  x: p.x - field.originX,
  y: p.y - field.originY,
  z: -(p.z - field.originZ),
})

/**
 * The signed gap between the HULL at `p` and the rock: negative inside.
 *
 * The contact test is five spheres within 1.6 m of the body origin, so asking
 * the route point alone would be off by up to that. Cheap enough to do
 * properly: the hull is five spheres and a spire is ~950 triangles.
 */
const hullGapToMesh = (
  mesh: PropMesh,
  p: { x: number; y: number; z: number },
  field: { originX: number; originY: number; originZ: number },
): number => {
  // AABB first, and it is not an optimisation for its own sake: the sweep that
  // asks "does the collider MISS rock" has to ask at every metre of thirteen
  // lines rather than only where a collider fires, which is 17 meshes x 5
  // spheres x ~1,000 triangles a metre. The box reject turns 143 s into
  // seconds and cannot change an answer — a point outside the mesh's own AABB
  // by `d` is outside the mesh by at least `d`, so the value it returns is a
  // true lower bound and every caller here only compares it against zero.
  const c = simToThree(p, field)
  const dx = Math.max(mesh.min.x - c.x, 0, c.x - mesh.max.x)
  const dy = Math.max(mesh.min.y - c.y, 0, c.y - mesh.max.y)
  const dz = Math.max(mesh.min.z - c.z, 0, c.z - mesh.max.z)
  const outsideBox = Math.hypot(dx, dy, dz)
  // 1.02 m is the widest hull sphere, so anything past it cannot reach.
  if (outsideBox > 2) return outsideBox
  let best = Number.POSITIVE_INFINITY
  for (const sphere of HULL) {
    // Level pose: the hull offsets go in unrotated, which is what the gate
    // below compares against — `propContactsBrute` is given the same identity
    // orientation, so the two sides see the same five points.
    const t = simToThree({ x: p.x + sphere.x, y: p.y + sphere.y, z: p.z + sphere.z }, field)
    const d = distanceToMesh(mesh, t.x, t.y, t.z)
    const signed = insideMesh(mesh, t.x, t.y, t.z) ? -d - sphere.radius : d - sphere.radius
    if (signed < best) best = signed
  }
  return best
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] as number
}

describe.skipIf(!haveForest)(
  'DEV-213: the line is inside a capsule — is it inside the rock?',
  () => {
    it('the oracle is sound: the spire meshes are closed and parity means something', () => {
      const m = new THREE.Matrix4()
      for (const asset of SPIRE_ASSETS) {
        const mesh = propMeshOf(asset, m)
        const wt = watertightFraction(mesh)
        const rod = rodOf(mesh)
        console.log(
          `DEV-213 ${asset}: ${mesh.count} triangles, edges paired ${(wt * 100).toFixed(2)} %, ` +
            `rod ${rod.length.toFixed(1)} m long, perp mean ${rod.meanPerp.toFixed(1)} / max ${rod.maxPerp.toFixed(1)} m`,
        )
        // 0.99 rather than 1.0: `spire-c` has three unpaired directed edges out of
        // 2,487 — a crack of a few triangles, not an open surface. Parity over
        // five fixed directions with a grazing reject survives that; a genuinely
        // open mesh (a plane, a shell) would come in far below this.
        expect(
          wt,
          `${asset} is not a closed surface — ray parity would be meaningless`,
        ).toBeGreaterThan(0.99)
        const c = new THREE.Vector3(
          (mesh.min.x + mesh.max.x) / 2,
          (mesh.min.y + mesh.max.y) / 2,
          (mesh.min.z + mesh.max.z) / 2,
        )
        expect(
          insideMesh(mesh, c.x, c.y, c.z),
          `${asset}: its own box centre is not inside it`,
        ).toBe(true)
        expect(insideMesh(mesh, mesh.max.x + 1000, c.y, c.z), `${asset}: a point 1 km away`).toBe(
          false,
        )
        // And the fit is a ROD: the long axis longer than the girth, or the
        // principal component is not picking out an axis at all. 2 rather than 3
        // because `spire-d` is the stubby one — 57.0 m long against a 24.5 m
        // half-girth, ratio 2.33, where b and c are 4.1 and 5.3.
        expect(rod.length / rod.maxPerp, `${asset} is not rod-shaped`).toBeGreaterThan(2)
      }
    }, 600_000)

    it("the fitted rod IS 2016's own capsule axis, on every live Spire_B", () => {
      // The fit is a device of this file's own, so on its own it proves nothing
      // (the agreement lesson). `Spire_B_w_Collision.prefab` carries two
      // hand-placed Unity capsules along the rod, through no importer — the
      // witness `spire-pivot.test.ts` uses — so their axis is an answer from
      // outside the port, and the two must agree to a couple of degrees.
      const CAPSULE_LOCAL_ROT = [0.102149546, -0.69464535, -0.7044865, 0.103596605] as const
      const qRot = (q: readonly number[], v: readonly number[]): number[] => {
        const [x, y, z, w] = q as [number, number, number, number]
        const [vx, vy, vz] = v as [number, number, number]
        const tx = 2 * (y * vz - z * vy)
        const ty = 2 * (z * vx - x * vz)
        const tz = 2 * (x * vy - y * vx)
        return [
          vx + w * tx + (y * tz - z * ty),
          vy + w * ty + (z * tx - x * tz),
          vz + w * tz + (x * ty - y * tx),
        ]
      }
      // Unity local +y of the capsule, taken to MESH-local (three) by the z flip.
      const u = qRot(CAPSULE_LOCAL_ROT, [0, 1, 0])
      const meshLocalAxis = new THREE.Vector3(u[0] as number, u[1] as number, -(u[2] as number))

      const rows: string[] = []
      let worst = 0
      for (const env of ['simonet', 'desert'] as const) {
        const local = terrainLocalPosition(environmentTerrains(env).land)
        for (const l of envLandmarks(env)) {
          if (l.meshAsset !== 'assets/props/spire-b.glb') continue
          const m = new THREE.Matrix4()
          landmarkMatrixOf(l, local, m)
          const rod = rodOf(propMeshOf(l.meshAsset, m))
          const expected = meshLocalAxis.clone().transformDirection(m).normalize()
          const got = new THREE.Vector3(
            rod.bx - rod.ax,
            rod.by - rod.ay,
            rod.bz - rod.az,
          ).normalize()
          // Sign-free: a principal component has no preferred end.
          const deg = (Math.acos(Math.min(1, Math.abs(got.dot(expected)))) * 180) / Math.PI
          worst = Math.max(worst, deg)
          rows.push(`${env.padEnd(8)} ${l.name.padEnd(24)} ${deg.toFixed(2).padStart(5)}°`)
        }
      }
      console.log(`DEV-213 fitted rod vs the 2016 capsules' own axis:\n  ${rows.join('\n  ')}`)
      expect(rows.length, 'no live Spire_B: the check ran on an empty set').toBeGreaterThan(10)
      expect(worst, 'the fitted rod is not the axis a human laid the capsules along').toBeLessThan(
        5,
      )
    }, 600_000)

    it('every metre of authored line inside a landmark capsule, against the mesh', () => {
      const rows: string[] = []
      let releaseRockMetres = -1
      let releaseCapsuleMetres = -1
      let releaseRacedCapsule = -1
      let missedTotal = 0
      let advOneCapsule = -1
      for (const id of MISSIONS) {
        const level = loadLevelJson(id)
        const field = fieldFor(level)
        const props = forestFor(level.environment, field, {
          ...FOREST_OPTIONS,
          missionProps: level.props ?? null,
        })
        const entries = landmarkEntries(level.environment, field, props, level.props ?? null)
        const route = crashLineOf(level)
        const at = v3()

        // WHERE the contact sits relative to the last ring. `level.route` is
        // 2016's `CurvyClonePath` and it does not stop at the final gate — on
        // `int_01` the last ring is at arc 10270 of an 11268 m spline, so the
        // tail is a kilometre of curve nobody races down. `crashCourseNow`
        // bounds the reset search at the next unscored gate's arc, and a run ends
        // at the finish, so a metre past `lastGateArc` is a metre of scenery.
        const gates: Gate[] = (
          (level.routes?.['0']?.rings ?? []) as { pos: number[]; trigger: { radius: number } }[]
        ).map((r) => ({
          centre: v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
          radius: r.trigger.radius,
          points: 100,
          triggerOnce: true,
        }))
        // The bound is the LATER of the final ring and the FINISH volume — every
        // shipped mission has one (`level.finish`, sim centre `(x, y, -z)`), and
        // on `int_01` it is past the last ring. Taking the ring alone would be
        // the convenient reading rather than the true one.
        const racedBound = Math.max(
          gates.length > 0 ? Math.max(...gateArcLengths(route, gates)) : 0,
          finishArc(route, level),
        )
        const lastGateArc = racedBound > 0 ? racedBound : route.length

        let capsuleMetres = 0
        let rockMetres = 0
        let rockRaced = 0
        let capsuleRaced = 0
        let deepestCapsule = 0
        let deepestRock = 0
        let missedRock = 0
        const gaps: number[] = []
        const names = new Set<string>()
        for (let s = 0; s <= route.length; s += 1) {
          routeAt(route, s, at)
          const p = { x: at.x, y: at.y, z: at.z }
          const contacts = propContactsBrute(p, LEVEL, HULL, props).filter((c) => entries.has(c))
          if (contacts.length === 0) {
            // ROCK THE COLLIDER DOES NOT COVER. Asked at every metre and not
            // only where the collider fires, because "the collider misses
            // rock" is invisible to a sweep conditioned on the collider —
            // which is how 78 m of `int_01`'s sea stack and 182 m of
            // `rookie_02_jumpSeat`'s mesas were solid on screen and not solid
            // to fly through, for the life of DEV-136.
            for (const [, e] of entries) {
              if (hullGapToMesh(e.mesh, p, field) <= 0) {
                missedRock++
                break
              }
            }
            continue
          }
          capsuleMetres++
          let gap = Number.POSITIVE_INFINITY
          for (const c of contacts) {
            const e = entries.get(c) as LandmarkEntry
            names.add(e.name)
            gap = Math.min(gap, hullGapToMesh(e.mesh, p, field))
            const pen =
              (props.radius[c] as number) +
              1.02 -
              Math.hypot(p.x - (props.x[c] as number), p.z - (props.z[c] as number))
            deepestCapsule = Math.max(deepestCapsule, pen)
          }
          if (s <= lastGateArc) capsuleRaced++
          if (gap <= 0) {
            rockMetres++
            if (s <= lastGateArc) rockRaced++
            deepestRock = Math.max(deepestRock, -gap)
          }
          gaps.push(gap)
        }
        if (capsuleMetres === 0 && missedRock === 0) continue
        missedTotal += missedRock
        if (id === 'adv_01_hoverJet') advOneCapsule = capsuleMetres
        if (id === 'int_01_hoverJet') {
          releaseRockMetres = rockMetres
          releaseCapsuleMetres = capsuleMetres
          releaseRacedCapsule = capsuleRaced
        }
        const clear = gaps.filter((g) => g > 0)
        rows.push(
          `${id.padEnd(20)} ${String(level.environment).padEnd(8)} ` +
            `capsule ${String(capsuleMetres).padStart(4)} m (deepest ${deepestCapsule.toFixed(1).padStart(6)} m) | ` +
            `ROCK ${String(rockMetres).padStart(4)} m ${`(${((rockMetres / capsuleMetres) * 100).toFixed(0)} %)`.padStart(6)} ` +
            `deepest ${deepestRock.toFixed(1).padStart(5)} m | ` +
            `gap where clear: min ${
              clear.length
                ? clear
                    .reduce((a, b) => Math.min(a, b))
                    .toFixed(1)
                    .padStart(6)
                : '     —'
            } ` +
            `med ${clear.length ? median(clear).toFixed(1).padStart(6) : '     —'} | ` +
            `rock MISSED ${String(missedRock).padStart(3)} m | ` +
            `BEFORE the finish (arc ${lastGateArc.toFixed(0).padStart(5)} of ${Math.round(route.length)}): ` +
            `capsule ${String(capsuleRaced).padStart(3)} m, rock ${String(rockRaced).padStart(3)} m | ` +
            `${[...names].join(', ')}`,
        )
      }
      console.log(
        `DEV-213 authored line inside a LANDMARK capsule, and inside its rock (hull-aware):\n  ${rows.join('\n  ')}`,
      )
      expect(
        rows.length,
        'no mission has line inside a landmark: nothing was measured',
      ).toBeGreaterThan(0)

      // FOUR GATES, and they fail in different directions on purpose.
      //
      // (1) NO ROCK IS MISSED, anywhere. This is the property the shipped
      //     vertical cylinder never had — it was 0.8-1.0x the rock's volume on
      //     the upright spires, so a ship flew through 78 m of `int_01`'s sea
      //     stack and 182 m of `rookie_02_jumpSeat`'s mesas. The convex hull
      //     CONTAINS the mesh by construction, and this is what says the
      //     construction survived the trip through `landmarkHullPlanes`, the
      //     z-mirror, `buildPropColliders`' origin shift and the hash.
      expect(missedTotal, 'a collider no longer covers rock the line flies through').toBe(0)
      // (2) `adv_01_hoverJet`'s phantom wall is GONE. 303 m of raced line
      //     inside a capsule that was 0 % rock, the worst point 117.7 m from
      //     the nearest triangle. That was the defect this row went looking
      //     for and it is the one number a regression would most likely undo.
      expect(advOneCapsule, 'adv_01_hoverJet has a landmark contact again').toBe(-1)
      // (3) `int_01_hoverJet` is mostly rock where it touches. Not 100 %: a
      //     convex hull round a concave rock has slack, and 36 m of the 184 is
      //     that slack rather than a misplaced collider. Two sister missions
      //     read 0 % on the same measurement before the shape changed, so the
      //     ratio is a fact about the Simonet rock and not about the method.
      expect(
        releaseCapsuleMetres,
        'int_01_hoverJet no longer touches a landmark at all',
      ).toBeGreaterThan(0)
      expect(
        releaseRockMetres / releaseCapsuleMetres,
        'int_01_hoverJet: the contact with the sea stack has become mostly AIR',
      ).toBeGreaterThan(0.7)
      // (4) And none of it is RACED. The contact sits 335 m past the finish
      //     volume, in the kilometre of `CurvyClonePath` that runs on after the
      //     course ends. If a change ever puts a metre of it before the finish,
      //     the release mission has acquired an obstacle on its racing line and
      //     somebody has to look at it in a headset — which is exactly the
      //     decision this file exists to have made cheap.
      expect(
        releaseRacedCapsule,
        'int_01_hoverJet: the release mission now meets a landmark BEFORE its finish',
      ).toBe(0)
    }, 900_000)

    it('the mechanism: a vertical capsule round a LEANING rod is a disc of air', () => {
      // Why two of the four missions read 0 %. The collider's radius is
      // `radiusFraction × drawn box width`, and for a rod tilted out of vertical
      // the drawn box's width is the rod's LENGTH, not its girth. So the capsule
      // grows with the tilt while the rock does not.
      const rows: string[] = []
      for (const env of ['simonet', 'desert'] as const) {
        const level = loadLevelJson(
          MISSIONS.find((m) => loadLevelJson(m).environment === env) as string,
        )
        const field = fieldFor(level)
        const props = forestFor(env, field, FOREST_OPTIONS)
        const entries = landmarkEntries(env, field, props)
        for (const [id, e] of entries) {
          const r = props.radius[id] as number
          const h = (props.top[id] as number) - (props.bottom[id] as number)
          // The radius 2016's own model would use: the rock's girth, measured
          // perpendicular to its OWN axis, through the same `radiusFraction`.
          const rodRadius = e.rod.maxPerp * 2 * SPEC.radiusFraction
          rows.push(
            `${env.padEnd(8)} ${e.name.padEnd(24)} tilt ${e.rod.tiltDegrees.toFixed(0).padStart(2)}° | ` +
              `rod ${e.rod.length.toFixed(0).padStart(4)} m long, girth ${(e.rod.maxPerp * 2).toFixed(0).padStart(3)} m | ` +
              `capsule r ${r.toFixed(1).padStart(6)} h ${h.toFixed(0).padStart(4)} | ` +
              `rod capsule r ${rodRadius.toFixed(1).padStart(5)} | ` +
              `vertical/rod radius ${(r / rodRadius).toFixed(2).padStart(5)}x`,
          )
        }
      }
      console.log(
        `DEV-213 the shape of each landmark's collider against the rock:\n  ${rows.join('\n  ')}`,
      )

      // THE MECHANISM, as a relationship rather than as a restated number (trap
      // 24): across the seventeen, a capsule's radius has to grow with the tilt.
      // A rod standing up needs no more radius than its girth; one lying down
      // needs its whole length. If that correlation ever vanishes the shape has
      // changed and this row's explanation no longer holds.
      const level = loadLevelJson('adv_01_hoverJet')
      const field = fieldFor(level)
      const props = forestFor('desert', field, FOREST_OPTIONS)
      const entries = landmarkEntries('desert', field, props)
      let flattest: [number, LandmarkEntry] | null = null
      let uprightest: [number, LandmarkEntry] | null = null
      for (const kv of entries) {
        if (!flattest || kv[1].rod.tiltDegrees > flattest[1].rod.tiltDegrees) flattest = kv
        if (!uprightest || kv[1].rod.tiltDegrees < uprightest[1].rod.tiltDegrees) uprightest = kv
      }
      const excess = (kv: [number, LandmarkEntry]): number =>
        (props.radius[kv[0]] as number) / (kv[1].rod.maxPerp * 2 * SPEC.radiusFraction)
      expect(
        excess(flattest as [number, LandmarkEntry]),
        'the flattest desert spire does not over-claim: the mechanism has changed',
      ).toBeGreaterThan(excess(uprightest as [number, LandmarkEntry]))
    }, 900_000)

    it("what a ROD capsule would cost: 2016's own shape, priced against the line", () => {
      // DEV-187 §4's third bullet — *"the honest port of that is a segment
      // capsule … it is the right next move if the landmarks stay solid"* —
      // measured rather than argued, on both lines that matter: 2016's authored
      // spline and the chord path a player actually flies.
      for (const [label, lineOf] of [
        ['spline (2016 CurvyClonePath)', crashLineOf],
        ['chord (spawn → ring centres)', gateLineOf],
      ] as const) {
        const rows: string[] = []
        for (const id of MISSIONS) {
          const level = loadLevelJson(id)
          const field = fieldFor(level)
          const props = forestFor(level.environment, field, {
            ...FOREST_OPTIONS,
            missionProps: level.props ?? null,
          })
          const entries = landmarkEntries(level.environment, field, props, level.props ?? null)
          const route = lineOf(level)
          if (route.length < 2) continue
          const at = v3()
          let vertical = 0
          let rodInside = 0
          let rock = 0
          let rodMissedRock = 0
          for (let s = 0; s <= route.length; s += 1) {
            routeAt(route, s, at)
            const p = { x: at.x, y: at.y, z: at.z }
            // Hoisted: `propContactsBrute` walks every collider in the
            // environment, so asking it once per landmark would be 17 sweeps of
            // 20,000 per metre of thirteen lines.
            const contacts = new Set(propContactsBrute(p, LEVEL, HULL, props))
            let inVertical = false
            let inRod = false
            let inRock = false
            for (const [cid, e] of entries) {
              const rodRadius = e.rod.maxPerp * 2 * SPEC.radiusFraction
              let near = false
              for (const sphere of HULL) {
                const t = simToThree(
                  { x: p.x + sphere.x, y: p.y + sphere.y, z: p.z + sphere.z },
                  field,
                )
                if (distanceToRod(e.rod, t.x, t.y, t.z) < rodRadius + sphere.radius) near = true
              }
              const inThisVertical = contacts.has(cid)
              if (near) inRod = true
              if (inThisVertical) inVertical = true
              if ((near || inThisVertical) && !inRock && hullGapToMesh(e.mesh, p, field) <= 0) {
                inRock = true
              }
            }
            if (inVertical) vertical++
            if (inRod) rodInside++
            if (inRock) rock++
            if (inRock && !inRod) rodMissedRock++
          }
          // Every mission with a usable line gets a row, including the zeros. A
          // missing row reads as "not measured" and the zeros are the finding.
          rows.push(
            `${id.padEnd(20)} ${String(level.environment).padEnd(8)} line ${String(Math.round(route.length)).padStart(5)} m | ` +
              `vertical capsule ${String(vertical).padStart(4)} m | rod capsule ${String(rodInside).padStart(4)} m | ` +
              `actually rock ${String(rock).padStart(4)} m | rod MISSES rock ${String(rodMissedRock).padStart(3)} m`,
          )
        }
        console.log(`DEV-213 vertical vs rod capsule, ${label}:\n  ${rows.join('\n  ')}`)
      }
    }, 900_000)

    it("int_01: the sea stack is on 2016's SPLINE and off the ring-to-ring chord", () => {
      // The distinction the two tables above turn on, stated as geometry rather
      // than as a count of metres.
      //
      // `level.route` is 2016's own `CurvyClonePath` — 22 control points at
      // granularity 20, the curve `SplinePathCloneBuilder` placed the rings
      // along. So a rock on it is a rock 2016 drew the course through, and the AI
      // racers, the crash reset and the reticle all follow it. But **nothing
      // makes a PLAYER follow a curve**: the rings are the constraint, and the
      // shortest legal path between two of them is the chord.
      const level = loadLevelJson('int_01_hoverJet')
      const field = fieldFor(level)
      const props = forestFor('simonet', field, FOREST_OPTIONS)
      const entries = landmarkEntries('simonet', field, props)
      const [id, entry] = [...entries][0] as [number, LandmarkEntry]
      const rings = (level.routes?.['0']?.rings ?? []) as {
        pos: number[]
        trigger: { radius: number }
      }[]

      const closest = (route: Route): { s: number; gap: number } => {
        const at = v3()
        let best = Number.POSITIVE_INFINITY
        let bestS = 0
        for (let s = 0; s <= route.length; s += 1) {
          routeAt(route, s, at)
          const g = hullGapToMesh(entry.mesh, { x: at.x, y: at.y, z: at.z }, field)
          if (g < best) {
            best = g
            bestS = s
          }
        }
        return { s: bestS, gap: best }
      }
      const spline = closest(crashLineOf(level))
      const chord = closest(gateLineOf(level))

      // Which rings it sits between, by arc length along the chord.
      const chordRoute = gateLineOf(level)
      let nearestRing = -1
      let nearestRingGap = Number.POSITIVE_INFINITY
      for (let i = 0; i < rings.length; i++) {
        const r = rings[i] as { pos: number[] }
        const p = { x: r.pos[0] as number, y: r.pos[1] as number, z: -(r.pos[2] as number) }
        const g = hullGapToMesh(entry.mesh, p, field)
        if (g < nearestRingGap) {
          nearestRingGap = g
          nearestRing = i
        }
      }
      // WHERE ON THE SPLINE, against the gates — the question the two numbers
      // above raise and cannot answer. `gateArcLengths` is the game's own, the
      // one `crashCourseNow` bounds `limitS` with.
      const splineRoute = crashLineOf(level)
      const gates: Gate[] = rings.map((r) => ({
        centre: v3(r.pos[0] as number, r.pos[1] as number, -(r.pos[2] as number)),
        radius: r.trigger.radius,
        points: 100,
        triggerOnce: true,
      }))
      const arcs = gateArcLengths(splineRoute, gates)
      const fArc = finishArc(splineRoute, level)
      const lastRingArc = Math.max(...arcs)
      // The raced line ends at the LATER of the two, which is the finish.
      const racedBound = Math.max(lastRingArc, fArc)
      // Every metre of spline inside the rock, and whether it is before or
      // after that bound.
      const atS = v3()
      let firstIn = -1
      let lastIn = -1
      let beforeFinish = 0
      for (let s = 0; s <= splineRoute.length; s += 1) {
        routeAt(splineRoute, s, atS)
        if (hullGapToMesh(entry.mesh, { x: atS.x, y: atS.y, z: atS.z }, field) > 0) continue
        if (firstIn < 0) firstIn = s
        lastIn = s
        if (s <= racedBound) beforeFinish++
      }
      console.log(
        `DEV-213 int_01_hoverJet, collider #${id} ${entry.name} ` +
          `(rod ${entry.rod.length.toFixed(0)} m at ${entry.rod.tiltDegrees.toFixed(0)}° from vertical):\n` +
          `  2016 spline: closest approach ${spline.gap.toFixed(1)} m at arc ${spline.s} of ${Math.round(splineRoute.length)} m\n` +
          `  ring chord : closest approach ${chord.gap.toFixed(1)} m at arc ${chord.s} of ${Math.round(chordRoute.length)} m\n` +
          `  nearest of the ${rings.length} ring centres: #${nearestRing}, ${nearestRingGap.toFixed(1)} m from the rock\n` +
          `  inside the rock from arc ${firstIn} to ${lastIn}\n` +
          `  last RING at arc ${lastRingArc.toFixed(0)}; FINISH volume at arc ${fArc.toFixed(0)} ` +
          `(${(fArc - lastRingArc).toFixed(0)} m further on — which is why the bound is the finish)\n` +
          `  gate arcs: ${arcs.map((a) => a.toFixed(0)).join(' ')}\n` +
          `  => ${beforeFinish} of ${lastIn - firstIn + 1} rock metres are BEFORE the finish`,
      )

      // THE GATE, as a relationship and not as a restated number: the chord
      // CLEARS the rock and the spline does not. If a future change makes them
      // agree, the "a player can simply fly round it" half of DEV-213's row has
      // stopped being true and the call has to be made again.
      expect(spline.gap, 'the 2016 spline no longer enters the sea stack').toBeLessThan(0)
      expect(chord.gap, 'the ring-to-ring chord now enters the sea stack too').toBeGreaterThan(0)
      expect(nearestRingGap, 'a ring centre is now inside the rock').toBeGreaterThan(0)
    }, 900_000)

    it('the SAME FRAME, spelled out — and a second derivation that uses no mesh', () => {
      // ── Why this test exists ──────────────────────────────────────────────
      //
      // "0 of 148 rock metres fall before the finish" un-asks a decision, so it
      // should not rest on one derivation through one oracle. This is the second,
      // and it deliberately shares nothing with the first: no `prop-mesh.ts`, no
      // ray parity, no point-triangle distance, no `PropColliders`. It bounds the
      // rock by the DRAWN BOX that `load-props.ts` already computes for the
      // collider, and asks how far the raced line stays outside it.
      //
      // ── The frame, because it is the easy thing to get wrong ──────────────
      //
      // A landmark's position and a ring's position are in DIFFERENT frames and
      // neither is "add `worldOffset`" (DEV-042: the offset you are missing is a
      // PARENT, composed, not a vector added).
      //
      //   ring  ->  sim = ( r.pos.x,  r.pos.y,  -r.pos.z )        a plain z flip
      //
      //   landmark pivot -> sim = ( p.x - local.x + origin.x,
      //                             p.y - local.y + origin.y,
      //                             p.z - local.z + origin.z )
      //
      //     local  = terrainLocalPosition(land)                  the terrain's own node
      //     origin = terrainOriginSim(land, level.worldOffset)   envRoot + local + worldOffset,
      //                                                          with z as local.z + root.z - wo.z
      //
      // The landmark's z is NOT flipped: `landmarkMatrixOf` negates it into THREE
      // space and `landmarkColliderInput` negates it back, so the two cancel.
      // Adding `worldOffset` to the raw landmark position — in either sign —
      // skips `local` and `envRoot` entirely and lands kilometres out.
      const level = loadLevelJson('int_01_hoverJet')
      const land = environmentTerrains('simonet').land
      const local = terrainLocalPosition(land)
      const origin = terrainOriginSim(land, level.worldOffset as number[]).position
      const l = envLandmarks('simonet')[0] as { name: string; position: readonly number[] }
      const pivot = {
        x: (l.position[0] as number) - (local[0] as number) + (origin[0] as number),
        y: (l.position[1] as number) - (local[1] as number) + (origin[1] as number),
        z: (l.position[2] as number) - (local[2] as number) + (origin[2] as number),
      }

      // The drawn box, in sim space, from `load-props.ts`'s own function — the
      // one the collider is already sized with. Conservative on purpose: `width`
      // is the LARGER of the x and z extents, so the square built from it
      // contains the true footprint, and a point outside this box is outside the
      // rock whatever the mesh does.
      const m = new THREE.Matrix4()
      landmarkMatrixOf(l as never, local, m)
      const g = glbShapeOf('assets/props/spire-b.glb')
      const box = drawnBoxOfVertices(new THREE.BufferAttribute(g.verts(), 3), m)
      const half = box.width / 2
      const boxSim = {
        minX: box.centreX - half + (origin[0] as number),
        maxX: box.centreX + half + (origin[0] as number),
        minY: box.base + (origin[1] as number),
        maxY: box.height + (origin[1] as number),
        // `landmarkColliderInput` takes `-box.centreZ`; the box is symmetric
        // about its centre so the half-width survives the flip unchanged.
        minZ: -box.centreZ - half + (origin[2] as number),
        maxZ: -box.centreZ + half + (origin[2] as number),
      }

      const route = crashLineOf(level)
      const fArc = finishArc(route, level)
      const at = v3()
      let minRacedToBox = Number.POSITIVE_INFINITY
      let minRacedToPivot = Number.POSITIVE_INFINITY
      let minAnyToBox = Number.POSITIVE_INFINITY
      for (let s = 0; s <= route.length; s += 1) {
        routeAt(route, s, at)
        const dx = Math.max(boxSim.minX - at.x, 0, at.x - boxSim.maxX)
        const dy = Math.max(boxSim.minY - at.y, 0, at.y - boxSim.maxY)
        const dz = Math.max(boxSim.minZ - at.z, 0, at.z - boxSim.maxZ)
        const toBox = Math.hypot(dx, dy, dz)
        minAnyToBox = Math.min(minAnyToBox, toBox)
        if (s > fArc) continue
        minRacedToBox = Math.min(minRacedToBox, toBox)
        minRacedToPivot = Math.min(
          minRacedToPivot,
          Math.hypot(at.x - pivot.x, at.y - pivot.y, at.z - pivot.z),
        )
      }

      // Every ring, sorted — not just the nearest. The first derivation names
      // ring #7 (hull to the MESH) and this one names #20 (centre to the BOX),
      // and printing the spread is what shows that to be two rings at nearly
      // the same distance rather than a disagreement: the box is a conservative
      // square built from the LARGER of the rock's two horizontal extents, so
      // box distance is always a lower bound on mesh distance, and which ring
      // wins can differ while both stay ~470–495 m out.
      const rings = (level.routes?.['0']?.rings ?? []) as { pos: number[] }[]
      const ringDistances = rings
        .map((r, i) => {
          const c = { x: r.pos[0] as number, y: r.pos[1] as number, z: -(r.pos[2] as number) }
          return {
            i,
            d: Math.hypot(
              Math.max(boxSim.minX - c.x, 0, c.x - boxSim.maxX),
              Math.max(boxSim.minY - c.y, 0, c.y - boxSim.maxY),
              Math.max(boxSim.minZ - c.z, 0, c.z - boxSim.maxZ),
            ),
          }
        })
        .sort((a, b) => a.d - b.d)

      console.log(
        `DEV-213 second derivation, int_01_hoverJet — no mesh, no capsule, no hull:\n` +
          `  terrainLocalPosition(simonet.land) = [${local.map((n) => n.toFixed(1)).join(', ')}]\n` +
          `  terrainOriginSim(land, worldOffset) = [${origin.map((n) => n.toFixed(1)).join(', ')}]\n` +
          `  landmark ${l.name} raw = [${l.position.map((n) => n.toFixed(1)).join(', ')}]\n` +
          `  -> pivot in SIM = (${pivot.x.toFixed(1)}, ${pivot.y.toFixed(1)}, ${pivot.z.toFixed(1)})\n` +
          `  drawn box in SIM: x ${boxSim.minX.toFixed(0)}..${boxSim.maxX.toFixed(0)}, ` +
          `y ${boxSim.minY.toFixed(0)}..${boxSim.maxY.toFixed(0)}, z ${boxSim.minZ.toFixed(0)}..${boxSim.maxZ.toFixed(0)}\n` +
          `  finish arc ${fArc} of ${Math.round(route.length)}\n` +
          `  nearest RACED point to the box   ${minRacedToBox.toFixed(1)} m (to the pivot ${minRacedToPivot.toFixed(1)} m)\n` +
          `  nearest point ANYWHERE on the spline to the box ${minAnyToBox.toFixed(1)} m\n` +
          `  four nearest ring centres to the box: ${ringDistances
            .slice(0, 4)
            .map((r) => `#${r.i} ${r.d.toFixed(1)} m`)
            .join(', ')}`,
      )

      // THE SECOND DERIVATION. The rock is a subset of its own drawn box, so a
      // raced point strictly outside that box cannot be inside the rock — and
      // this reaches that conclusion without ever asking the triangles.
      expect(
        minRacedToBox,
        "a raced metre of int_01 is now inside the sea stack's own drawn box",
      ).toBeGreaterThan(0)
      // And not by a hair: the first derivation says the nearest raced approach
      // is hundreds of metres, so a tolerance this size is the claim and not a
      // rounding allowance.
      expect(minRacedToBox, 'the raced clearance has collapsed').toBeGreaterThan(100)
      // The un-raced tail DOES reach it, or the two derivations are not about the
      // same rock.
      expect(minAnyToBox, 'the spline never reaches the box at all').toBe(0)
    }, 900_000)

    it('WHICH SHAPE is closest to the rock: cylinder, rod, disc stack, convex hull', () => {
      // Matt, 2026-09-18: *"i'd prefer it the colliders were closer to the mesh
      // than rods"*. This is the ladder that answers it, in the one currency
      // that needs no sampling and carries no seed: **claimed volume ÷ the
      // rock's own volume**, both analytic — the divergence theorem over the
      // mesh's triangles, and a closed form for each candidate shape.
      //
      // The surprise is that the tighter-sounding shapes lose. A **disc stack**
      // is 2016's own model generalised — `Spire_B_w_Collision.prefab` carries
      // two hand-placed capsules along the rod at different radii, which is a
      // two-slab taper — and it never gets below **2.4x** however many slabs it
      // is given, because a slab's cross-section is an irregular polygon and
      // `pi r^2` on its circumscribed radius overestimates that badly. Adding
      // slabs refines the shape ALONG the axis, and the loss is ACROSS it.
      //
      // **The convex hull is not rotationally symmetric and does not pay
      // that**: 1.30-1.52x, and it is the same ratio for every instance of an
      // asset because it is scale-invariant.
      //
      // The shipped vertical cylinder's 1.58x average is the number to read
      // last, because the average is the least informative thing about it: it
      // is 0.8-1.0x on the four upright spires, where it is SMALLER than the
      // rock and lets a ship through, and 2.6-3.1x on the leaning ones, where
      // it is the phantom wall DEV-213 measured on `adv_01_hoverJet`. A shape
      // that is wrong in both directions at once does not have a meaningful
      // mean.
      const SLAB_LADDER = [1, 2, 4, 8, 16, 32, 64]
      const rows: string[] = []
      let meshTotal = 0
      let cylinderTotal = 0
      let hullTotal = 0
      const slabTotals = new Map(SLAB_LADDER.map((k) => [k, 0]))

      for (const env of ['simonet', 'desert'] as const) {
        const level = loadLevelJson(
          MISSIONS.find((m) => loadLevelJson(m).environment === env) as string,
        )
        const field = fieldFor(level)
        const props = forestFor(env, field, FOREST_OPTIONS)
        for (const [id, e] of landmarkEntries(env, field, props)) {
          const vol = meshVolume(e.mesh)
          const r = props.radius[id] as number
          const h = (props.top[id] as number) - (props.bottom[id] as number)
          const cylinder = Math.PI * r * r * h
          const hull = hullVolume(e.mesh)
          meshTotal += vol
          cylinderTotal += cylinder
          hullTotal += hull
          const perK: string[] = []
          for (const k of SLAB_LADDER) {
            const sv = discStackVolume(discStackOf(e.mesh, e.rod, k))
            slabTotals.set(k, (slabTotals.get(k) as number) + sv)
            perK.push(`${k}:${(sv / vol).toFixed(1)}`)
          }
          rows.push(
            `${env.padEnd(8)} ${e.name.padEnd(24)} tilt ${e.rod.tiltDegrees.toFixed(0).padStart(2)}° ` +
              `mesh ${(vol / 1e6).toFixed(2).padStart(5)} Mm³ | shipped cylinder ${(cylinder / vol).toFixed(2).padStart(4)}x | ` +
              `CONVEX HULL ${(hull / vol).toFixed(2)}x | disc stack ${perK.join(' ')}`,
          )
        }
      }
      console.log(
        `DEV-213 collider volume ÷ the rock's own volume (1.00 would be the mesh itself):\n  ${rows.join('\n  ')}`,
      )
      console.log(
        `DEV-213 across all seventeen — shipped cylinder ${(cylinderTotal / meshTotal).toFixed(2)}x, ` +
          `CONVEX HULL ${(hullTotal / meshTotal).toFixed(2)}x, disc stack ` +
          SLAB_LADDER.map(
            (k) => `${k} ${((slabTotals.get(k) as number) / meshTotal).toFixed(2)}x`,
          ).join(' / '),
      )

      // THE PREMISE the hull rests on, and the one the cylinder never had: it
      // CONTAINS the rock. Every vertex of every landmark, at the tolerance a
      // float32 round trip through the instance matrix allows.
      for (const env of ['simonet', 'desert'] as const) {
        const level = loadLevelJson(
          MISSIONS.find((m) => loadLevelJson(m).environment === env) as string,
        )
        const field = fieldFor(level)
        const props = forestFor(env, field, FOREST_OPTIONS)
        for (const [, e] of landmarkEntries(env, field, props)) {
          const h = convexHullOf(e.mesh)
          let worstOut = 0
          const t = e.mesh.tris
          for (let i = 0; i < e.mesh.count * 3; i++) {
            worstOut = Math.max(
              worstOut,
              gapToHull(h, t[i * 3] as number, t[i * 3 + 1] as number, t[i * 3 + 2] as number),
            )
          }
          expect(
            worstOut,
            `${env} ${e.name}: a vertex is OUTSIDE its own convex hull`,
          ).toBeLessThan(0.05)
        }
      }

      // THE FINDING, as a relationship rather than a restated number (trap 24):
      // the hull beats every rotationally symmetric candidate, and no number of
      // slabs closes the gap. If a future asset made that false the choice of
      // shape would need re-arguing, and this goes red rather than quietly
      // staying the wrong answer.
      const hullRatio = hullTotal / meshTotal
      for (const k of SLAB_LADDER) {
        expect(
          (slabTotals.get(k) as number) / meshTotal,
          `a ${k}-slab disc stack is tighter than the convex hull`,
        ).toBeGreaterThan(hullRatio)
      }
      expect(hullRatio, 'the convex hull is no longer close to the rock').toBeLessThan(1.6)
    }, 900_000)

    it('each candidate shape against the authored lines: PHANTOM metres, and rock MISSED', () => {
      // The volume ladder says which shape is tightest; this says what that is
      // worth where it is felt. `phantom` is collider metres that are NOT rock
      // — the wall made of nothing. `missed` is rock the collider does not
      // cover — a ship flying through a mountain. A shape wants both at zero.
      //
      // `shipped` is the GAME's collider, read through `propContactsBrute`: a
      // vertical cylinder until DEV-213, the convex hull until DEV-345, and
      // since DEV-345 the hull with the rock's own triangles behind it — so it
      // should read the rock metre for metre, phantom 0 and missed 0. The other
      // three are candidate shapes built here, kept as the record of what was
      // weighed.
      const rows: string[] = []
      for (const id of MISSIONS) {
        const level = loadLevelJson(id)
        const field = fieldFor(level)
        const props = forestFor(level.environment, field, {
          ...FOREST_OPTIONS,
          missionProps: level.props ?? null,
        })
        const entries = landmarkEntries(level.environment, field, props, level.props ?? null)
        const route = crashLineOf(level)
        if (route.length < 2) continue
        const shapes = new Map(
          [...entries].map(
            ([cid, e]) =>
              [
                cid,
                {
                  stack: discStackOf(e.mesh, e.rod, LANDMARK_SLABS),
                  hull: convexHullOf(e.mesh),
                },
              ] as const,
          ),
        )
        const at = v3()
        const tally = {
          shipped: { phantom: 0, missed: 0, hit: 0 },
          rod: { phantom: 0, missed: 0, hit: 0 },
          stack: { phantom: 0, missed: 0, hit: 0 },
          hull: { phantom: 0, missed: 0, hit: 0 },
        }
        let rock = 0
        for (let s = 0; s <= route.length; s += 1) {
          routeAt(route, s, at)
          const p = { x: at.x, y: at.y, z: at.z }
          const contacts = new Set(propContactsBrute(p, LEVEL, HULL, props))
          let inRock = false
          const hit = { shipped: false, rod: false, stack: false, hull: false }
          for (const [cid, e] of entries) {
            const sh = shapes.get(cid) as { stack: DiscStack; hull: HullPlanes }
            if (contacts.has(cid)) hit.shipped = true
            const rodRadius = e.rod.maxPerp * 2 * SPEC.radiusFraction
            for (const sphere of HULL) {
              const w = simToThree(
                { x: p.x + sphere.x, y: p.y + sphere.y, z: p.z + sphere.z },
                field,
              )
              if (distanceToRod(e.rod, w.x, w.y, w.z) < rodRadius + sphere.radius) hit.rod = true
              if (gapToDiscStack(sh.stack, w.x, w.y, w.z) < sphere.radius) hit.stack = true
              if (gapToHull(sh.hull, w.x, w.y, w.z) < sphere.radius) hit.hull = true
            }
            if (!inRock && hullGapToMesh(e.mesh, p, field) <= 0) inRock = true
          }
          if (inRock) rock++
          for (const k of ['shipped', 'rod', 'stack', 'hull'] as const) {
            if (hit[k]) tally[k].hit++
            if (hit[k] && !inRock) tally[k].phantom++
            if (inRock && !hit[k]) tally[k].missed++
          }
        }
        if (rock === 0 && tally.shipped.hit === 0 && tally.hull.hit === 0) continue
        rows.push(
          `${id.padEnd(20)} ${String(level.environment).padEnd(8)} rock ${String(rock).padStart(4)} m | ` +
            (['shipped', 'rod', 'stack', 'hull'] as const)
              .map(
                (k) =>
                  `${k} ${String(tally[k].hit).padStart(4)} m (phantom ${String(tally[k].phantom).padStart(4)}, missed ${String(tally[k].missed).padStart(3)})`,
              )
              .join(' | '),
        )
      }
      console.log(
        `DEV-213 the four candidate shapes along every authored line (2016's spline):\n  ${rows.join('\n  ')}`,
      )
      expect(rows.length, 'no mission touched a landmark under any shape').toBeGreaterThan(0)
    }, 900_000)
  },
)

describe.skipIf(haveForest)('DEV-213: the mesh attribution is skipped here', () => {
  it('says so, and says why, rather than reporting a pass', () => {
    expect(haveForest).toBe(false)
    console.log(
      'DEV-213: skipped — the height maps and the spire GLBs are gitignored and come ' +
        'from R2 (`pnpm assets:pull`). Nothing in this file has a synthetic half: ' +
        'every claim is about the shipped rocks.',
    )
  })
})
