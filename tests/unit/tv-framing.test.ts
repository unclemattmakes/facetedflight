// DEV-652: the Director never puts its eye in a gate's frame or the ground, and
// never leaves its racer a dot. Tested as GEOMETRY:
//
//   1. THE ENVELOPE IS THE ASSET'S. `GATE_FRAME` is a literal; the real
//      `checkpoint-ring.glb`, through the real `gateFramePose`, is measured here
//      and must sit inside it (every vertex is "in the solid") and must not be
//      far inside it (the envelope is not a lie in the other direction).
//   2. The distance function says what a person would: in a bar is 0, the
//      middle of the hole is far, the far end of the tube is not "inside".
//   3. THE SWEEP: over every HoverJet Ring Attack course (the real height maps
//      and forest), a field flown along the racing line is filmed through the
//      whole race by the real camera; no frame's FINAL eye is within the keep-out
//      of any gate frame, nor under the ground, nor behind it from its subject.
//
// The glTF work is inside the `it`s, never above a guard, and the sweep has a
// loud counterpart at the foot of the file.

// DEV-652: the Director never puts its eye in a gate's frame or the ground, and
// never leaves its racer a dot. Tested as GEOMETRY:
//
//   1. THE ENVELOPE IS THE ASSET'S. `GATE_FRAME` is a literal; the real
//      `checkpoint-ring.glb`, through the real `gateFramePose`, is measured here
//      and must sit inside it (every vertex is "in the solid") and must not be
//      far inside it (the envelope is not a lie in the other direction).
//   2. The distance function says what a person would: in a bar is 0, the
//      middle of the hole is far, the far end of the tube is not "inside".
//   3. THE SWEEP: over every HoverJet Ring Attack course (the real height maps
//      and forest), a field flown along the racing line is filmed through the
//      whole race by the real camera; no frame's FINAL eye is within the keep-out
//      of any gate frame, nor under the ground, nor behind it from its subject.
//
// The glTF work is inside the `it`s, never above a guard, and the sweep has a
// loud counterpart at the foot of the file.

import fs, { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { type Level, validateLevel } from '@/content/level-schema'
import { bakedGeometry } from '@/game/rings'
import { createTvCamera, type TvCraft } from '@/game/tv/tv-camera'
import {
  distanceToGateFrame,
  eyeInGateFrame,
  eyeProblem,
  FRAMING,
  farthestFor,
  GATE_FRAME,
  type GateFrame,
  subjectFraction,
  USER_LIMITS,
} from '@/game/tv/tv-framing'
import {
  buildRoute,
  gateFramesOf,
  projectOnRoute,
  routeHeadingAt,
  routePointAt,
  tvBoundsOf,
  tvCourseOf,
} from '@/game/tv/tv-vantage'
import { PROPS } from '@/generated/constants.generated'
import { unityPose } from '@/render/unity-space'
import { haveForest } from './helpers/prop-forest'
import { INT01 } from './helpers/tv-race'
import { tvWorldFor } from './helpers/tv-world'

const RING_GLB = 'public/assets/props/checkpoint-ring.glb'
const haveRing = existsSync(RING_GLB)

const framePoseGeometry = async (): Promise<THREE.BufferGeometry> => {
  const b = readFileSync(RING_GLB)
  const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  const scene = await new Promise<THREE.Group>((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
  const geometry = bakedGeometry(scene)
  if (!geometry) throw new Error('checkpoint-ring.glb has no mesh')
  const ring = PROPS.checkpointRing
  const m = new THREE.Matrix4()
  for (const p of ring.framePivots) m.multiply(unityPose(p.position, p.rotation, p.scale))
  m.multiply(unityPose(ring.frame.position, ring.frame.rotation, ring.frame.scale))
  geometry.applyMatrix4(m)
  geometry.computeBoundingBox()
  return geometry
}

const UNIT_GATE: GateFrame = { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: 1 }

describe.skipIf(!haveRing)("DEV-652: the gate envelope is the asset's", () => {
  it('contains every vertex of the real frame (so a vertex is never reported as clear air)', async () => {
    const geometry = await framePoseGeometry()
    const pos = geometry.getAttribute('position')
    let worst = 0
    for (let i = 0; i < pos.count; i++) {
      const d = distanceToGateFrame(UNIT_GATE, [pos.getX(i), pos.getY(i), pos.getZ(i)])
      if (d > worst) worst = d
    }
    expect(worst).toBe(0)
  })

  it('is not far outside it: the envelope is within 5 % of the mesh on each outer axis and depth', async () => {
    const geometry = await framePoseGeometry()
    const box = geometry.boundingBox as THREE.Box3
    const near = (envelope: number, mesh: number): void => {
      expect(Math.abs(envelope - mesh) / mesh).toBeLessThan(0.05)
    }
    near(GATE_FRAME.outerX, Math.max(-box.min.x, box.max.x))
    near(GATE_FRAME.outerY, Math.max(-box.min.y, box.max.y))
    near(-GATE_FRAME.zMin, -box.min.z)
    near(GATE_FRAME.zMax, box.max.z)
  })

  it('keeps the hole open: the frame has no vertex nearer the axis than the envelope says', async () => {
    const geometry = await framePoseGeometry()
    const pos = geometry.getAttribute('position')
    let nearestX = Number.POSITIVE_INFINITY
    let nearestY = Number.POSITIVE_INFINITY
    for (let i = 0; i < pos.count; i++) {
      // The hole's half-width is where the bars start along each axis.
      if (Math.abs(pos.getY(i)) < 0.5) nearestX = Math.min(nearestX, Math.abs(pos.getX(i)))
      if (Math.abs(pos.getX(i)) < 0.5) nearestY = Math.min(nearestY, Math.abs(pos.getY(i)))
    }
    // The envelope's inner edge is pulled IN (thicker bars than the mesh has).
    expect(GATE_FRAME.innerX).toBeLessThanOrEqual(nearestX + 1e-9)
    expect(GATE_FRAME.innerY).toBeLessThanOrEqual(nearestY + 1e-9)
    // ... but not absurdly so.
    expect(nearestX - GATE_FRAME.innerX).toBeLessThan(2)
    expect(nearestY - GATE_FRAME.innerY).toBeLessThan(2)
  })
})

describe.skipIf(haveRing)('DEV-652: the envelope check is skipped here (loud counterpart)', () => {
  it('skips only because the ring glb is absent', () => {
    expect(haveRing).toBe(false)
  })
})

describe('DEV-652: distance to a gate frame', () => {
  const ring = INT01.routes[0]?.rings[0]
  const gate = (): GateFrame => {
    if (!ring) throw new Error('no ring')
    return {
      pos: ring.pos as unknown as GateFrame['pos'],
      quat: ring.quat as unknown as GateFrame['quat'],
      scale: ring.scale[0] as number,
    }
  }

  it('is 0 in a bar, large in the middle of the hole and past either end of the tube', () => {
    const g = gate()
    const at = (x: number, y: number, z: number): [number, number, number] => {
      // gate-local (pre-scale) to world: rotate by the gate's quat, scale, translate.
      const q = new THREE.Quaternion(...g.quat)
      const v = new THREE.Vector3(x, y, z).multiplyScalar(g.scale).applyQuaternion(q)
      return [v.x + g.pos[0], v.y + g.pos[1], v.z + g.pos[2]]
    }
    // The right-hand bar's middle, half-way through the depth.
    expect(distanceToGateFrame(g, at((GATE_FRAME.innerX + GATE_FRAME.outerX) / 2, 0, -1))).toBe(0)
    // The middle of the hole: as far from every bar as the hole is wide.
    expect(distanceToGateFrame(g, at(0, 0, 0))).toBeGreaterThan(8 * g.scale)
    // Past either end of the tube, on the axis: its distance from the nearest end face is not 0.
    expect(distanceToGateFrame(g, at(GATE_FRAME.outerX - 1, 0, 40))).toBeGreaterThan(
      (40 - GATE_FRAME.zMax) * g.scale * 0.99,
    )
    expect(distanceToGateFrame(g, at(GATE_FRAME.outerX - 1, 0, -40))).toBeGreaterThan(
      (40 + GATE_FRAME.zMin) * g.scale * 0.99,
    )
  })

  it('keeps an eye out of the frame by the keep-out, and lets one through the middle', () => {
    const g = gate()
    const q = new THREE.Quaternion(...g.quat)
    const world = (x: number, y: number, z: number): [number, number, number] => {
      const v = new THREE.Vector3(x, y, z).multiplyScalar(g.scale).applyQuaternion(q)
      return [v.x + g.pos[0], v.y + g.pos[1], v.z + g.pos[2]]
    }
    // Inside the tube, against a bar: refused. Along the axis, in the hole: allowed.
    expect(eyeInGateFrame([g], world(GATE_FRAME.outerX - 1, 0, 0))).toBe(0)
    expect(eyeInGateFrame([g], world(0, 0, 0))).toBe(-1)
    expect(eyeInGateFrame([g], world(0, 0, 60))).toBe(-1)
    // Just inside the keep-out of a bar's outer face: refused.
    const out = (GATE_FRAME.outerX + FRAMING.gateKeepOut / g.scale - 0.5) * 1
    expect(eyeInGateFrame([g], world(out, 0, 0))).toBe(0)
    expect(eyeInGateFrame([g], world(out + 2, 0, 0))).toBe(-1)
  })
})

describe('DEV-652: the subject-size floor', () => {
  it('sizes a hull by distance and field of view, and inverts it', () => {
    const d = farthestFor(60)
    expect(subjectFraction(d, 60)).toBeCloseTo(FRAMING.minSubject, 9)
    // Nearer is bigger, a wider lens is smaller.
    expect(subjectFraction(d / 2, 60)).toBeGreaterThan(FRAMING.minSubject)
    expect(subjectFraction(d, 90)).toBeLessThan(FRAMING.minSubject)
  })

  it('is at least a few dozen pixels at 1080p where the floor is held', () => {
    // 4.5 % of 1080 rows is ~49 px: a racer you can read, not a speck.
    expect(FRAMING.minSubject * 1080).toBeGreaterThan(40)
  })
})

describe('DEV-652: the eye and the ground', () => {
  const flat = (): number => 100
  it('refuses an eye too near the ground, and a subject hidden behind a ridge', () => {
    const world = { heightAt: flat, gates: [] }
    expect(eyeProblem(world, [0, 102, 0], null)).toBe('ground')
    expect(eyeProblem(world, [0, 110, 0], null)).toBeNull()
    // A 60 m wall between the eye and the subject.
    const wall = (x: number): number => (x > 40 && x < 60 ? 200 : 100)
    expect(eyeProblem({ heightAt: (x) => wall(x), gates: [] }, [0, 130, 0], [100, 130, 0])).toBe(
      'ground',
    )
    expect(
      eyeProblem({ heightAt: (x) => wall(x), gates: [] }, [0, 130, 0], [30, 130, 0]),
    ).toBeNull()
  })
})

// ── the sweep ─────────────────────────────────────────────────────────────

const LEVEL_DIR = path.join(__dirname, '..', '..', 'content', 'levels')
const ringAttackCourses = (): Level[] =>
  fs
    .readdirSync(LEVEL_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) =>
      validateLevel(JSON.parse(fs.readFileSync(path.join(LEVEL_DIR, f), 'utf8')) as Level),
    )
    .filter((l) => l.vehicle === 'hoverjet' && l.mode === 'ringAttack')

describe.skipIf(!haveForest)('DEV-652: the Director over every HoverJet Ring Attack course', () => {
  it("never leaves its eye in a gate's frame, the ground, or behind it, from the grid to the finish", () => {
    const courses = ringAttackCourses()
    expect(courses).toHaveLength(6)
    const rows: string[] = []
    const failures: string[] = []
    for (const level of courses) {
      const world = tvWorldFor(level)
      const course = tvCourseOf(level)
      const route = buildRoute(course.route)
      const gates = gateFramesOf(level)
      // Five racers abreast along the line, a few metres apart in a column, at 80 m/s from the start.
      const SPEED = 80
      const SEATS = 5
      // Mutable craft: three vectors, which satisfy `TvCraft` structurally.
      const craft = Array.from({ length: SEATS }, (_, i) => ({
        id: `sweep:${i}`,
        name: `Racer ${i + 1}`,
        racer: i + 1,
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
      }))
      // The racers stop at the finish: the line runs on past it, over ground a racer never flies.
      const finish = course.finish
      const total = finish
        ? projectOnRoute(route, finish[0], finish[1], finish[2]).arc
        : route.length
      const place = (t: number): void => {
        craft.forEach((c, i) => {
          // Staggered along the line by 18 m and across it by 6 m, as a grid is.
          const arc = Math.min(total, Math.max(0, SPEED * t - i * 18))
          const [x, y, z] = routePointAt(route, arc)
          const [hx, hz] = routeHeadingAt(route, arc)
          const side = (i % 2 === 0 ? 1 : -1) * 6
          // Two metres over the line, so the ghost-flown sample is not ON the bars.
          c.position.set(x - hz * side, y, z + hx * side)
          // A craft noses along local -Z.
          c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(hx, 0, hz))
        })
      }
      const cam = createTvCamera({
        craft: () => craft as readonly TvCraft[],
        presenting: () => false,
        heightAt: world.heightAt,
        bounds: tvBoundsOf(level),
        course,
        obstructed: world.obstructed,
      })
      const rig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
      const head = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
      const DT = 1 / 30
      const duration = total / SPEED + 4
      let frames = 0
      let adjusted = 0
      let bad = 0
      let legacyInGate = 0
      const framings = new Map<string, number>()
      for (let t = 0; t < duration; t += DT) {
        place(t)
        cam.frame(DT, rig, head)
        frames++
        const r = cam.report()
        if (r.framing) framings.set(r.framing, (framings.get(r.framing) ?? 0) + 1)
        if (r.eyeProblem) adjusted++
        // The BEFORE: the chase this replaced stood 24 m behind and 7 m over its racer, wherever that was.
        {
          const c0 = craft[0] as (typeof craft)[number]
          const [hx, hz] = routeHeadingAt(route, Math.max(0, SPEED * t))
          const legacy: [number, number, number] = [
            c0.position.x - hx * 24,
            c0.position.y + 7,
            c0.position.z - hz * 24,
          ]
          if (eyeInGateFrame(gates, legacy) >= 0) legacyInGate++
        }
        const eye: [number, number, number] = [rig.position.x, rig.position.y, rig.position.z]
        const subject = craft.find((c) => c.name === r.following)
        const p = subject
          ? ([subject.position.x, subject.position.y, subject.position.z] as [
              number,
              number,
              number,
            ])
          : null
        // Held to the keep-out, over the same ground the camera reads.
        const problem = eyeProblem({ heightAt: world.heightAt, gates }, eye, p)
        if (problem && r.framing !== 'opening') {
          bad++
          if (failures.length < 20)
            failures.push(`${level.id} t=${t.toFixed(1)} ${r.framing}: ${problem}`)
        }
      }
      rows.push(
        `${level.id.padEnd(20)} ${String(frames).padStart(5)} frames, ${String(adjusted).padStart(4)} proposed eyes moved, ${bad} bad finals (the old 24 m chase: ${legacyInGate} frames in a gate frame); ` +
          [...framings].map(([k, n]) => `${k} ${n}`).join(', '),
      )
    }
    console.info(`DEV-652 Director sweep:\n${rows.join('\n')}`)
    expect(failures).toEqual([])
    // The premise: the old chase WAS in a gate's frame on these courses, so the zero above is earned.
    expect(rows.some((r) => !/the old 24 m chase: 0 frames/.test(r))).toBe(true)
  }, 600_000)
})

describe.skipIf(haveForest)(
  'DEV-652: the Director sweep is skipped here (loud counterpart)',
  () => {
    it('skips only because the gitignored height maps and prop GLBs are absent', () => {
      expect(haveForest).toBe(false)
    })
  },
)

// A viewer's own orbit is held to the near plane's rule, not the Director's
// berth. TV spec "a click-drag orbits the chase" failed at 10.7 m instead of 25
// because the Director's 11 m gate keep-out was applied to the viewer's eye: on
// the real courses about 8 % of drag frames were pulled in.
describe.skipIf(!haveForest)("DEV-652: a viewer's orbit holds its radius", () => {
  it('holds the chase radius through a drag at every point of every course, but for the near plane', () => {
    const reach = Math.hypot(24, 7) // the chase's offset; the orbit's radius at zoom 1
    const rows: string[] = []
    let shortened = 0
    const bad: string[] = []
    for (const level of ringAttackCourses()) {
      const world = tvWorldFor(level)
      const course = tvCourseOf(level)
      const route = buildRoute(course.route)
      const gates = gateFramesOf(level)
      let frames = 0
      let held = 0
      for (let arc = 100; arc < route.length - 300; arc += 15) {
        const craft = {
          id: 'a',
          name: 'a',
          position: new THREE.Vector3(...routePointAt(route, arc)),
          quaternion: new THREE.Quaternion(),
        }
        const [hx, hz] = routeHeadingAt(route, arc)
        craft.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(hx, 0, hz),
        )
        const cam = createTvCamera({
          craft: () => [craft],
          presenting: () => false,
          heightAt: world.heightAt,
          bounds: tvBoundsOf(level),
          course,
          obstructed: world.obstructed,
          mode: 'follow',
        })
        const rig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
        const head = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
        cam.frame(0.01, rig, head)
        for (let i = 1; i <= 12; i++) {
          cam.frame(0.01, rig, head, { lookDx: 25, lookDy: -4 })
          frames++
          const eye: [number, number, number] = [rig.position.x, rig.position.y, rig.position.z]
          const d = rig.position.distanceTo(craft.position)
          const problem = cam.report().eyeProblem
          if (Math.abs(d - reach) < 0.01) {
            held++
            expect(problem, 'a held eye had no problem to move for').toBeNull()
          } else {
            shortened++
            // Moved either by this rule (a fault in the proposal, `problem`) or by the chase's own
            // 3 m lift off the ground (`flatClearance`, older than this row). Never by the Director's berth.
            // Only the near plane's rule may shorten it: the eye it WAS to be at is in a gate's
            // solid or the ground, which the shortened eye then is not.
            if (eyeProblem({ heightAt: world.heightAt, gates }, eye, null, USER_LIMITS) !== null)
              bad.push(
                `${level.id} arc ${arc} step ${i}: shortened eye still in the near plane's zone`,
              )
          }
        }
      }
      rows.push(`${level.id}: ${held}/${frames} orbit frames at the full radius`)
      expect(held / frames, `${level.id}: share of the drag held at the radius`).toBeGreaterThan(
        0.94,
      )
    }
    console.info(`DEV-652 orbit sweep:\n${rows.join('\n')}`)
    expect(bad).toEqual([])
    void shortened
  }, 600_000)
})
