// tests/unit/editor-flyby.test.ts — the editor's fly-by. DEV-474.
//
//  §1 FLYBY_POLICY, pinned by value (the HUD_RASTER_SHIPPED pattern), and the
//     two numbers it does NOT type, tied to where they come from.
//  §2 the schedule: bounded however long the line, looping, moving forward.
//  §3 the GEOMETRY on the real hull (the orientation lesson: no quaternion in
//     this file). A ship placed on a line has its tapering end — the nose —
//     further along the line than its other end, and in a bend its inside
//     wing is the lower one. Both directions of turn, because a sign error is
//     invisible in one of them. The hull GLB is gitignored (hard rule 7), so
//     §3 skips where it is absent and §4 is its loud counterpart.
//  §5 DEV-487's dart, which needs no asset: closed and wound outward, and
//     pointing ONE way in plan and in profile; placed on the same six turns,
//     its point is further along the line than its tail.
//  §6 the LOD decision: the hull where it reads, the dart where it does not,
//     and one change of shape at the boundary, not one a frame.
//  §7 the fly-by as a whole, on a stand-in hull: far ships are darts in ONE
//     instanced mesh, a ship close to the eye is its hull, and a ship keeps
//     its own shape across a launch, when every ship's slot shifts by one.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import type { Vec3Tuple } from '@/content/level-schema'
import { EDITOR_POLICY, tightestTurnRadius } from '@/editor/core'
import {
  createFlyby,
  type FlybyLod,
  flybyArcs,
  flybyArrowGeometry,
  flybyLaunchBase,
  flybyLine,
  flybyLod,
  flybyShipFrom,
  flybySpacing,
  placeFlybyShip,
} from '@/editor/desk/flyby'
import { FLYBY_POLICY, flybyMaxBank, flybySpeed } from '@/editor/desk/policy'
import { HOVERJET } from '@/generated/constants.generated'
import { cruiseSpeed } from '@/sim/hoverjet'

describe('§1 FLYBY_POLICY', () => {
  it('is pinned by value: moving one is an edit made here on purpose', () => {
    expect(FLYBY_POLICY).toEqual({
      launchSeconds: 4,
      maxShips: 12,
      shipScreenFraction: 0.04,
      maxStepSeconds: 0.1,
      hullScreenFraction: 0.08,
      lodHysteresis: 0.8,
      arrowWidth: 0.7,
      arrowNotch: 0.3,
      arrowHeight: 0.22,
    })
  })

  it('flies at the cruise the tight-turn warning judges a bend at', () => {
    expect(flybySpeed()).toBe(cruiseSpeed(HOVERJET))
    // The same speed DEV-468's warning squares: its radius IS this speed's.
    expect(flybySpeed() ** 2 / EDITOR_POLICY.latAccelMeasured).toBeCloseTo(tightestTurnRadius(), 9)
    // 2016's sheet: about 89.8 m/s. A plausible HoverJet pace, not a guess.
    expect(flybySpeed()).toBeGreaterThan(85)
    expect(flybySpeed()).toBeLessThan(95)
  })

  it('banks no further than a coordinated turn at the measured lateral limit', () => {
    const deg = THREE.MathUtils.radToDeg(flybyMaxBank())
    expect(deg).toBeGreaterThan(75)
    expect(deg).toBeLessThan(82)
  })
})

describe('§2 the schedule', () => {
  const v = flybySpeed()

  it('is bounded by maxShips on any line, however long', () => {
    let most = 0
    let outside = 0
    for (const length of [0, 50, 400, 1000, 3000, 12_000, 63_000, 250_000]) {
      for (let clock = 0; clock < 600; clock += 0.37) {
        const arcs = flybyArcs(clock, length, v)
        most = Math.max(most, arcs.length)
        for (const s of arcs) if (s < 0 || s >= length) outside++
      }
    }
    expect(most).toBe(FLYBY_POLICY.maxShips)
    expect(outside).toBe(0)
  })

  it('launches every launchSeconds on a line the cap covers, and stretches past it', () => {
    expect(flybySpacing(2000, v)).toBe(FLYBY_POLICY.launchSeconds)
    const long = 100_000
    expect(flybySpacing(long, v)).toBeGreaterThan(FLYBY_POLICY.launchSeconds)
    // Stretched exactly so that maxShips cover it end to end.
    expect(flybySpacing(long, v) * v * FLYBY_POLICY.maxShips).toBeCloseTo(long, 6)
  })

  it('has several in flight at once on an ordinary course, one launch interval apart', () => {
    const length = 2500 // a ~2.5 km line: 28 s at cruise
    const arcs = flybyArcs(123.4, length, v)
    expect(arcs.length).toBeGreaterThanOrEqual(6)
    for (let i = 1; i < arcs.length; i++) {
      expect((arcs[i] as number) - (arcs[i - 1] as number)).toBeCloseTo(
        FLYBY_POLICY.launchSeconds * v,
        6,
      )
    }
  })

  it('moves every ship forward along the line, and loops', () => {
    const length = 2500
    const dt = 0.05
    for (let clock = 0; clock < 60; clock += 0.61) {
      const a = flybyArcs(clock, length, v)
      const b = flybyArcs(clock + dt, length, v)
      // Every ship still in flight a moment later is `v·dt` further on.
      for (const s of a) {
        if (s + v * dt >= length) continue
        expect(b.some((t) => Math.abs(t - (s + v * dt)) < 1e-6)).toBe(true)
      }
      // One launch interval later the picture is the same: it loops.
      const c = flybyArcs(clock + FLYBY_POLICY.launchSeconds, length, v)
      expect(c.length).toBe(a.length)
      c.forEach((s, i) => {
        expect(s).toBeCloseTo(a[i] as number, 6)
      })
    }
  })
})

// ── §3 on the real hull ──────────────────────────────────────────────────

const GLB = 'public/assets/ships/hoverjet-exterior.glb'
const available = fs.existsSync(GLB)

const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** Every vertex of the ship, world space, with its position in the ship's own frame. */
const verticesOf = (ship: THREE.Object3D): { world: THREE.Vector3; local: THREE.Vector3 }[] => {
  ship.updateWorldMatrix(true, true)
  const inverse = ship.matrixWorld.clone().invert()
  const out: { world: THREE.Vector3; local: THREE.Vector3 }[] = []
  ship.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const p = mesh.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const world = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(
        mesh.matrixWorld,
      )
      out.push({ world, local: world.clone().applyMatrix4(inverse) })
    }
  })
  return out
}

/**
 * The hull's two ends along its longest horizontal extent in its own frame —
 * found without naming an axis — and how wide it is near each (the outer 15 %).
 * The NOSE is the end that tapers (`parked-ship.test.ts` settles the same
 * question the same way). Also the two wing tips: the extremes across.
 */
const anatomyOf = (ship: THREE.Object3D) => {
  const vs = verticesOf(ship)
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity)
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const v of vs) {
    lo.min(v.local)
    hi.max(v.local)
  }
  const extent = hi.clone().sub(lo)
  const axis: 'x' | 'z' = extent.x >= extent.z ? 'x' : 'z'
  const cross: 'x' | 'z' = axis === 'x' ? 'z' : 'x'
  const len = extent[axis]
  let a = vs[0] as (typeof vs)[number]
  let b = a
  let left = a
  let right = a
  let widthA = 0
  let widthB = 0
  for (const v of vs) {
    if (v.local[axis] < a.local[axis]) a = v
    if (v.local[axis] > b.local[axis]) b = v
    if (v.local[cross] < left.local[cross]) left = v
    if (v.local[cross] > right.local[cross]) right = v
    if (v.local[axis] < lo[axis] + len * 0.15) widthA = Math.max(widthA, Math.abs(v.local[cross]))
    if (v.local[axis] > hi[axis] - len * 0.15) widthB = Math.max(widthB, Math.abs(v.local[cross]))
  }
  const nose = widthA < widthB ? a.world : b.world
  const tail = widthA < widthB ? b.world : a.world
  return { nose, tail, tips: [left.world, right.world] as const, widthA, widthB }
}

/** Arc length along a dense polyline of the point nearest `p`. */
const arcNearest = (dense: readonly THREE.Vector3[], p: THREE.Vector3): number => {
  let best = Infinity
  let bestArc = 0
  let arc = 0
  const seg = new THREE.Line3()
  const q = new THREE.Vector3()
  for (let i = 1; i < dense.length; i++) {
    seg.set(dense[i - 1] as THREE.Vector3, dense[i] as THREE.Vector3)
    const u = seg.closestPointToPointParameter(p, true)
    seg.at(u, q)
    const d = q.distanceTo(p)
    if (d < best) {
      best = d
      bestArc = arc + u * seg.distance()
    }
    arc += seg.distance()
  }
  return bestArc
}

/**
 * A climbing turn of `radius` round the origin, `sign` +1 one way and −1 the
 * other, sampled every 25 m like an expanded route. Its centre of curvature
 * is on the y axis, which is what "the inside wing" is measured against.
 */
const helix = (radius: number, sign: 1 | -1, climbPerMetre: number): Vec3Tuple[] => {
  const out: Vec3Tuple[] = []
  const turn = Math.PI * 1.5
  const steps = Math.ceil((turn * radius) / 25)
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turn * sign
    out.push([
      radius * Math.cos(a),
      climbPerMetre * (i / steps) * turn * radius,
      radius * Math.sin(a),
    ])
  }
  return out
}

describe.skipIf(!available)('§3 the geometry, on the real hull', () => {
  const prototype = async () => flybyShipFrom(await parse(), new THREE.MeshBasicMaterial())

  it('finds a nose two independent ways, and they agree', async () => {
    // The taper alone is a modest signal on this hull (about 1.2 : 1 across
    // the outer 15 %), so it is checked against a second fact about the mesh:
    // the ship's origin is the pilot's seat (`ART_POSITION` hangs the art
    // round it), and the seat is nearer the nose than the exhaust — DEV-040's
    // sweep: the art runs −2.2 to +4.4 and the long end is the exhaust.
    const ship = await prototype()
    const { nose, tail, widthA, widthB } = anatomyOf(ship)
    expect(Math.max(widthA, widthB) / Math.min(widthA, widthB)).toBeGreaterThan(1.1)
    expect(nose.length(), 'the tapering end is the one nearer the seat').toBeLessThan(
      tail.length() - 1,
    )
  })

  for (const sign of [1, -1] as const) {
    for (const climb of [0, 0.15, -0.15]) {
      it(`flies nose-first along a ${sign > 0 ? 'left' : 'right'}-hand ${climb === 0 ? 'level' : climb > 0 ? 'climbing' : 'diving'} turn`, async () => {
        const proto = await prototype()
        const route = helix(400, sign, climb)
        const line = flybyLine(route)
        if (!line) throw new Error('no line')
        const dense = line.points
        for (const s of [60, 300, 700, 1100, line.length - 60]) {
          const ship = proto.clone()
          placeFlybyShip(ship, line, s, flybySpeed())
          const { nose, tail } = anatomyOf(ship)
          // The point ahead of the nose lies further along the line.
          expect(arcNearest(dense, nose), `s=${s}: nose further on than tail`).toBeGreaterThan(
            arcNearest(dense, tail) + 5,
          )
        }
      })
    }

    it(`banks INTO a ${sign > 0 ? 'left' : 'right'}-hand turn: the inside wing is lower`, async () => {
      const proto = await prototype()
      // 250 m at cruise: 32 m/s² of centripetal against 32 of gravity, a 45°
      // bank — plainly visible, and well inside the limit.
      const line = flybyLine(helix(250, sign, 0))
      if (!line) throw new Error('no line')
      for (const s of [200, 500, 800]) {
        const ship = proto.clone()
        placeFlybyShip(ship, line, s, flybySpeed())
        const { tips } = anatomyOf(ship)
        const [p, q] = tips
        const inside = Math.hypot(p.x, p.z) < Math.hypot(q.x, q.z) ? p : q
        const outside = inside === p ? q : p
        expect(inside.y, `s=${s}: inside tip below outside tip`).toBeLessThan(outside.y - 1)
      }
    })
  }

  it('flies level on a straight: the wing tips at one height', async () => {
    const proto = await prototype()
    const route: Vec3Tuple[] = Array.from({ length: 40 }, (_, i) => [i * 25, 50, i * 10])
    const line = flybyLine(route)
    if (!line) throw new Error('no line')
    const ship = proto.clone()
    placeFlybyShip(ship, line, 400, flybySpeed())
    const [p, q] = anatomyOf(ship).tips
    expect(Math.abs(p.y - q.y)).toBeLessThan(0.05)
  })
})

describe.skipIf(available)('§4 the hull is not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})

// ── §5 DEV-487's dart ────────────────────────────────────────────────────

/** The dart's triangles, as vertex triples. */
const trianglesOf = (geometry: THREE.BufferGeometry): THREE.Vector3[][] => {
  const p = geometry.attributes.position as THREE.BufferAttribute
  const out: THREE.Vector3[][] = []
  for (let i = 0; i < p.count; i += 3) {
    out.push([0, 1, 2].map((k) => new THREE.Vector3(p.getX(i + k), p.getY(i + k), p.getZ(i + k))))
  }
  return out
}

/**
 * The two ends of a shape along its longest horizontal extent, in its own
 * frame, and which one tapers — measured twice, independently: by its WIDTH
 * (what the eye sees from above) and by its HEIGHT (from the side). No axis is
 * assumed to be the nose; the taper decides.
 */
const tapersOf = (ship: THREE.Object3D) => {
  const vs = verticesOf(ship)
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity)
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const v of vs) {
    lo.min(v.local)
    hi.max(v.local)
  }
  const extent = hi.clone().sub(lo)
  const axis: 'x' | 'z' = extent.x >= extent.z ? 'x' : 'z'
  const cross: 'x' | 'z' = axis === 'x' ? 'z' : 'x'
  const band = extent[axis] * 0.15
  const span = (near: (v: THREE.Vector3) => boolean, k: 'x' | 'y' | 'z') => {
    let a = Infinity
    let b = -Infinity
    for (const v of vs) {
      if (!near(v.local)) continue
      a = Math.min(a, v.local[k])
      b = Math.max(b, v.local[k])
    }
    return b - a
  }
  const nearLo = (v: THREE.Vector3) => v[axis] < lo[axis] + band
  const nearHi = (v: THREE.Vector3) => v[axis] > hi[axis] - band
  const end = (near: (v: THREE.Vector3) => boolean) => {
    const pick = vs.filter((v) => near(v.local))
    return pick.reduce((sum, v) => sum.add(v.world), new THREE.Vector3()).divideScalar(pick.length)
  }
  /** Where along the axis the shape is widest (plan) and tallest (profile), 0 at `lo` and 1 at `hi`. */
  const peak = (size: (v: THREE.Vector3) => number) => {
    let best = vs[0] as (typeof vs)[number]
    for (const v of vs) if (size(v.local) > size(best.local)) best = v
    return (best.local[axis] - lo[axis]) / extent[axis]
  }
  return {
    width: { lo: span(nearLo, cross), hi: span(nearHi, cross) },
    height: { lo: span(nearLo, 'y'), hi: span(nearHi, 'y') },
    widest: peak((v) => Math.abs(v[cross])),
    tallest: peak((v) => v.y),
    extent: { across: extent[cross], up: extent.y },
    ends: { lo: end(nearLo), hi: end(nearHi) },
  }
}

/** A ship drawn as the dart alone, as the fly-by's instances are: the ship's matrix, the dart geometry. */
const dartShip = (length = 7): THREE.Object3D => {
  const ship = new THREE.Group()
  ship.add(new THREE.Mesh(flybyArrowGeometry(length), new THREE.MeshBasicMaterial()))
  return ship
}

describe('§5 the dart (DEV-487)', () => {
  it('is closed, and every face is wound to face OUT of it', () => {
    const tris = trianglesOf(flybyArrowGeometry(7))
    expect(tris.length).toBe(6)
    const centroid = new THREE.Vector3()
    for (const t of tris) for (const v of t) centroid.add(v)
    centroid.divideScalar(tris.length * 3)
    // Closed: every edge is walked once each way by the two faces that share it.
    const edges = new Map<string, number>()
    const key = (a: THREE.Vector3, b: THREE.Vector3) => `${a.toArray()}>${b.toArray()}`
    for (const [a, b, c] of tris as [THREE.Vector3, THREE.Vector3, THREE.Vector3][]) {
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as const) {
        edges.set(key(u, v), (edges.get(key(u, v)) ?? 0) + 1)
      }
      // Outward: the counter-clockwise normal points away from the solid.
      const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a))
      const out = a.clone().add(b).add(c).divideScalar(3).sub(centroid)
      expect(n.dot(out), 'a face wound inward').toBeGreaterThan(0)
    }
    for (const [k, count] of edges) {
      expect(count).toBe(1)
      const [u, v] = k.split('>')
      expect(edges.get(`${v}>${u}`), `edge ${k} has a partner`).toBe(1)
    }
  })

  it('is the length it is asked for, centred where it is asked', () => {
    const box = new THREE.Box3().setFromBufferAttribute(
      flybyArrowGeometry(9, 1.5).attributes.position as THREE.BufferAttribute,
    )
    expect(box.max.z - box.min.z).toBeCloseTo(9, 6)
    expect((box.max.z + box.min.z) / 2).toBeCloseTo(1.5, 6)
  })

  it('points ONE way from above and from the side: widest and tallest toward the same end', () => {
    const { width, height, widest, tallest, extent } = tapersOf(dartShip())
    // From above it is widest at one end, and from the side tallest toward
    // that same end — well past the middle, not a diamond either way.
    const tailIsHi = widest > 0.5
    expect(tailIsHi ? widest : 1 - widest).toBeGreaterThan(0.9)
    expect(tailIsHi ? tallest : 1 - tallest, 'plan and profile agree').toBeGreaterThan(0.6)
    // And the other end is a POINT in both views: across the outer 15 %, a
    // fraction of the shape's whole width and height.
    const pointW = tailIsHi ? width.lo : width.hi
    const pointH = tailIsHi ? height.lo : height.hi
    expect(pointW / extent.across).toBeLessThan(0.2)
    expect(pointH / extent.up).toBeLessThan(0.3)
  })

  for (const sign of [1, -1] as const) {
    for (const climb of [0, 0.15, -0.15]) {
      it(`flies point-first along a ${sign > 0 ? 'left' : 'right'}-hand ${climb === 0 ? 'level' : climb > 0 ? 'climbing' : 'diving'} turn`, () => {
        const line = flybyLine(helix(400, sign, climb))
        if (!line) throw new Error('no line')
        for (const s of [60, 300, 700, 1100, line.length - 60]) {
          const ship = dartShip()
          placeFlybyShip(ship, line, s, flybySpeed())
          const { width, ends } = tapersOf(ship)
          const point = width.lo < width.hi ? ends.lo : ends.hi
          const tail = point === ends.lo ? ends.hi : ends.lo
          expect(
            arcNearest(line.points, point),
            `s=${s}: the point is further on than the tail`,
          ).toBeGreaterThan(arcNearest(line.points, tail) + 3)
        }
      })
    }
  }
})

// ── §6 the LOD decision ──────────────────────────────────────────────────

describe('§6 hull or dart (DEV-487)', () => {
  const enter = FLYBY_POLICY.hullScreenFraction
  const leave = enter * FLYBY_POLICY.lodHysteresis

  it('is the hull where it is big, the dart where it is small, whatever it was', () => {
    for (const was of [undefined, 'hull', 'arrow'] as const) {
      expect(flybyLod(was, enter)).toBe('hull')
      expect(flybyLod(was, 1)).toBe('hull')
      expect(flybyLod(was, leave * 0.999)).toBe('arrow')
      expect(flybyLod(was, FLYBY_POLICY.shipScreenFraction)).toBe('arrow')
    }
  })

  it('every ship grown to be seen is a dart: the hull threshold is above the grown size', () => {
    expect(leave).toBeGreaterThan(FLYBY_POLICY.shipScreenFraction)
  })

  it('keeps what it was between the two thresholds; a new ship there is a dart', () => {
    const mid = (enter + leave) / 2
    expect(flybyLod('hull', mid)).toBe('hull')
    expect(flybyLod('arrow', mid)).toBe('arrow')
    expect(flybyLod(undefined, mid)).toBe('arrow')
  })

  it('changes shape once, not every frame, for a ship dithering at either boundary', () => {
    for (const edge of [enter, leave]) {
      for (const start of ['hull', 'arrow'] as const) {
        let lod: FlybyLod = start
        let changes = 0
        for (let i = 0; i < 200; i++) {
          const next = flybyLod(lod, edge * (1 + 0.02 * Math.sin(i * 0.9)))
          if (next !== lod) changes++
          lod = next
        }
        expect(changes, `dithering at ${edge.toFixed(3)} from ${start}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ── §7 the fly-by as a whole, on a stand-in hull ─────────────────────────

describe('§7 the fly-by draws darts far and hulls near (DEV-487)', () => {
  const v = flybySpeed()
  /** A 7 m box standing in for the hull: the pool, the LOD and the arrows, with no asset. */
  const standIn = (): THREE.Object3D => {
    const ship = new THREE.Group()
    ship.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 7), new THREE.MeshBasicMaterial()))
    return ship
  }
  /** A straight 3 km line along +x, 50 m up. */
  const straight: Vec3Tuple[] = Array.from({ length: 121 }, (_, i) => [i * 25, 50, 0])
  const flown = (eye: THREE.Vector3) => {
    const flyby = createFlyby()
    flyby.setPrototype(standIn())
    flyby.setRoute(straight)
    const camera = new THREE.PerspectiveCamera()
    camera.position.copy(eye)
    return { flyby, camera }
  }
  const arrowsOf = (flyby: ReturnType<typeof createFlyby>) =>
    flyby.object.getObjectByName('editor-flyby-arrows') as THREE.InstancedMesh
  const hullShown = (ship: THREE.Object3D) => (ship.children[0] as THREE.Object3D).visible

  it('from far off, every ship is a dart, all of them in ONE instanced mesh', () => {
    const { flyby, camera } = flown(new THREE.Vector3(1500, 3000, 0))
    for (let i = 0; i < 200; i++) flyby.update(0.05, camera)
    const ships = flyby.object.children.filter((o) => o.name.startsWith('editor-flyby-ship:'))
    const flying = ships.filter((s) => s.visible)
    expect(flying.length).toBeGreaterThanOrEqual(6)
    expect(flying.some(hullShown), 'no hull drawn from 3 km').toBe(false)
    const arrows = arrowsOf(flyby)
    expect(arrows.count).toBe(flying.length)
    expect(flyby.object.userData.flyby).toMatchObject({ hulls: 0, arrows: flying.length })
    // Each instance stands where its ship does, at its ship's size.
    const m = new THREE.Matrix4()
    const at = new THREE.Vector3()
    const scale = new THREE.Vector3()
    const arcs = flying.map((s) => s.position.x).sort((a, b) => a - b)
    for (let i = 0; i < arrows.count; i++) {
      arrows.getMatrixAt(i, m)
      m.decompose(at, new THREE.Quaternion(), scale)
      // (The instance matrices are float32: a millimetre at 3 km.)
      expect(Math.min(...arcs.map((x) => Math.abs(x - at.x)))).toBeLessThan(1e-3)
      expect(scale.x).toBeGreaterThan(1) // grown: 4 % of ~3 km
    }
    flyby.dispose()
  })

  it('a ship passing close to the eye is its hull, and a dart again once past', () => {
    const { flyby, camera } = flown(new THREE.Vector3(1500, 50 + 40, 0))
    const hullLength = 7
    const enter = hullLength / FLYBY_POLICY.hullScreenFraction
    const leave = enter / FLYBY_POLICY.lodHysteresis
    let sawHull = 0
    let hullInBand = 0
    for (let i = 0; i < 400; i++) {
      flyby.update(0.05, camera)
      for (const ship of flyby.ships()) {
        const d = ship.position.distanceTo(camera.position)
        if (ship.lod === 'hull') {
          sawHull++
          expect(d, 'a hull only inside the far threshold').toBeLessThan(leave + 1)
          if (d > enter + 1) hullInBand++
        } else {
          expect(d, 'a dart only outside the near threshold').toBeGreaterThan(enter - 1)
        }
      }
    }
    expect(sawHull, 'ships passed close enough to show the hull').toBeGreaterThan(0)
    expect(hullInBand, 'the hull is kept on the way out (the hysteresis)').toBeGreaterThan(0)
    flyby.dispose()
  })

  it('a ship keeps its own shape across a launch, when every slot shifts by one', () => {
    // A launch every 4 s (3 km is well inside the cap), so at clock 8 the ship
    // that left at 0 is at 2 · 4 · v metres, and it moves from slot 1 to slot 2.
    // Put the eye where that ship is inside the band on its way OUT, having
    // passed within 40 m: it is a hull, and must still be one after the launch.
    const spacing = flybySpacing(3000, v)
    expect(spacing).toBe(FLYBY_POLICY.launchSeconds)
    const x = 2 * spacing * v
    const enter = 7 / FLYBY_POLICY.hullScreenFraction
    const leave = enter / FLYBY_POLICY.lodHysteresis
    const behind = Math.sqrt(((enter + leave) / 2) ** 2 - 40 ** 2)
    const { flyby, camera } = flown(new THREE.Vector3(x - behind, 50 + 40, 0))
    const near = (): { lod: FlybyLod; d: number } => {
      const ships = flyby.ships()
      const ship = ships.reduce((a, b) => (Math.abs(a.arc - x) < Math.abs(b.arc - x) ? a : b))
      return { lod: ship.lod, d: ship.position.distanceTo(camera.position) }
    }
    // Up to just before the launch at 8 s, then across it.
    let clock = 0
    while (clock < 2 * spacing - 0.03) {
      flyby.update(0.02, camera)
      clock += 0.02
    }
    const before = near()
    expect(before.d).toBeGreaterThan(enter)
    expect(before.d).toBeLessThan(leave)
    expect(before.lod).toBe('hull')
    expect(flybyLaunchBase(clock, spacing)).toBe(1)
    flyby.update(0.05, camera)
    clock += 0.05
    expect(flybyLaunchBase(clock, spacing), 'a launch happened').toBe(2)
    const after = near()
    expect(after.d).toBeLessThan(leave)
    expect(after.lod, 'the same ship, the same shape').toBe('hull')
    flyby.dispose()
  })

  it('names ships by launch: ship i is launch base − i, and its arc follows its own clock', () => {
    const spacing = flybySpacing(3000, v)
    for (let clock = 0.013; clock < 60; clock += 0.37) {
      const base = flybyLaunchBase(clock, spacing)
      flybyArcs(clock, 3000, v).forEach((s, i) => {
        expect(s).toBeCloseTo((clock - (base - i) * spacing) * v, 6)
      })
    }
  })
})
