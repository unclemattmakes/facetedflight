// tests/unit/lift-seal.test.ts — the world stays outside 2016's shaft (DEV-460).
//
// Matt, 2026-09-27: *"right now player eyes visibly collde through geo (like the
// ocean)"*. The sea stood in the corners of 2016's shaft at eye level, and the
// ground came on inside it at the reveal, because the sea's hole and the land's
// hold were sized off the generated round bore about the SHIP, not off the
// square shaft about the LIFT that DEV-438 stood in its place.
//
// The claims are SIGHTLINES, cast from the eye over the whole sphere against
// what the rig draws (front faces, as its material does), with the sea and the
// ground modelled as surfaces at any height the ride can meet them — not the
// outline `lift-seal.ts` computes, which would be the implementation asked to
// agree with itself. The one TS twin here (the shader's hole test) is pinned
// to the GLSL by a structural test beside it.
//
// The rig GLB and the terrain maps are never in git (hard rule 7), so the half
// that reads them is guarded, the disk work is inside each `it`, and the guard
// has a loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { ART_POSITION, ART_SCALE, EYE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { SHIP_MESH_WINGS } from '@/game/ship-wings'
import { environmentTerrains, terrainParams } from '@/game/terrain/load-terrain'
import { TERRAIN } from '@/generated/constants.generated'
import { createElevator, revealRiseFor } from '@/render/elevator'
import { createHangar } from '@/render/hangar'
import { createLaunchArt, HANGAR_ROOM_MESH } from '@/render/hangar-art'
import {
  appendTriangles,
  COLUMN_MARGIN,
  capColumn,
  centroidOf,
  columnRadiusOf,
  footprintOf,
  grownHull,
  hatchGeometry,
  hatchHeightOf,
  holeTableFor,
  hullXZ,
  type LiftSeal,
  landRevealFor,
  REVEAL_LEAD,
  reachAlong,
  sealLift,
  sectionAt,
  trimColumn,
  waveReach,
  worldTopIn,
  type Xz,
} from '@/render/lift-seal'
import { cutShaftAtRim } from '@/render/start-grid'
import { applyWaterWaves, SHAFT_REACH_STEPS } from '@/render/water'
import { hangarSpecFor } from '@/sim/hangar'
import { grayscale } from '@/sim/terrain/faceted'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import { type ImageData8, importUnityTexture, type MapSampler } from '@/sim/terrain/image-sampler'
import { decodePngBuffer } from '../../tools/terrain/png.mjs'
import { fieldFor, haveMaps, loadLevelJson, MAPS, oceanFieldFor } from './helpers/terrain-field'

/** Anniversary's detail ring's jitter, as a share of the terrain's own (the preset's). */
const ANNIVERSARY_RING_JITTER = (
  JSON.parse(fs.readFileSync('content/editions/anniversary.json', 'utf8')) as {
    terrain: { detailRing: { jitterScale: number } }
  }
).terrain.detailRing.jitterScale

/** The land's height MAP, as `load-terrain.ts` imports it — what the detail ring draws off. */
const maps = new Map<string, MapSampler>()
const mapFor = (environment: string): MapSampler => {
  const hit = maps.get(environment)
  if (hit) return hit
  const img = decodePngBuffer(fs.readFileSync(MAPS[environment] as string), environment)
  const sampler = importUnityTexture(img as ImageData8)
  maps.set(environment, sampler)
  return sampler
}

const ROOM_FILE = `public/${HANGAR_ROOM_MESH}`
const AVAILABLE = fs.existsSync(ROOM_FILE) && haveMaps

// ── the pure geometry: no files ─────────────────────────────────────────────

/** A unit square column at the origin, counter-clockwise in (x, z). */
const SQUARE: Xz[] = [
  { x: -1, z: -1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 },
  { x: -1, z: 1 },
]

const areaOf = (g: THREE.BufferGeometry): number => {
  const p = g.getAttribute('position')
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let area = 0
  for (let t = 0; t + 2 < p.count; t += 3) {
    a.fromBufferAttribute(p, t)
    b.fromBufferAttribute(p, t + 1)
    c.fromBufferAttribute(p, t + 2)
    area += new THREE.Triangle(a, b, c).getArea()
  }
  return area
}

describe('the lift-seal geometry', () => {
  it('hulls counter-clockwise, grows outward, and finds the middle', () => {
    const hull = hullXZ([...SQUARE, { x: 0, z: 0 }, { x: 0.5, z: -0.2 }])
    expect(hull).toHaveLength(4)
    let signed = 0
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i] as Xz
      const b = hull[(i + 1) % hull.length] as Xz
      signed += a.x * b.z - a.z * b.x
    }
    expect(signed, 'counter-clockwise in (x, z)').toBeGreaterThan(0)
    const grown = grownHull(hull, 0.1)
    for (const a of [0, 0.7, 2, 4]) {
      expect(reachAlong(grown, { x: 0, z: 0 }, a)).toBeGreaterThan(
        reachAlong(hull, { x: 0, z: 0 }, a) + 0.099,
      )
    }
    const c = centroidOf(hull)
    expect(Math.hypot(c.x, c.z)).toBeLessThan(1e-9)
  })

  it('trims a wall out of the column, keeps what stands outside, and keeps its winding', () => {
    // A vertical wall crossing the column: x from -3 to 3 at z = 0.
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-3, 0, 0, 3, 0, 0, 3, 2, 0, -3, 0, 0, 3, 2, 0, -3, 2, 0],
        3,
      ),
    )
    g.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0], 3),
    )
    const t = trimColumn(g, SQUARE)
    expect(areaOf(t), 'the 2 m inside the column went, the 4 m either side stayed').toBeCloseTo(
      8,
      5,
    )
    const p = t.getAttribute('position')
    for (let i = 0; i < p.count; i++) {
      expect(Math.abs(p.getX(i)), 'nothing inside').toBeGreaterThanOrEqual(1 - 1e-6)
    }
    // The colour runs 0 at x = -3 to 1 at x = 3 along the bottom edge: at the
    // cut, x = -1, it is a third of the way.
    const c = t.getAttribute('color')
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i) + 1) < 1e-6 && Math.abs(p.getY(i)) < 1e-6)
        expect(c.getX(i)).toBeCloseTo(1 / 3, 5)
    }
    // Winding: every piece faces -z as the wall did (b-a x c-a along -z... check sign).
    const n0 = new THREE.Triangle(
      new THREE.Vector3(-3, 0, 0),
      new THREE.Vector3(3, 0, 0),
      new THREE.Vector3(3, 2, 0),
    ).getNormal(new THREE.Vector3())
    for (let i = 0; i + 2 < p.count; i += 3) {
      const n = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(p, i),
        new THREE.Vector3().fromBufferAttribute(p, i + 1),
        new THREE.Vector3().fromBufferAttribute(p, i + 2),
      ).getNormal(new THREE.Vector3())
      if (n.lengthSq() > 0) expect(n.dot(n0)).toBeGreaterThan(0.99)
    }
    // A wall that never enters the column comes back untouched.
    const far = new THREE.BufferGeometry()
    far.setAttribute('position', new THREE.Float32BufferAttribute([3, 0, 0, 5, 0, 0, 5, 2, 0], 3))
    expect(trimColumn(far, SQUARE)).toBe(far)
  })

  it('DEV-551: closes a solid the column cut, on its walls, facing into the column', () => {
    // A slab 6 x 0.5 x 6 m right across the 2 m column: a catwalk, simplified.
    // Cut, it is a slab with a square hole and an open shell; capped, the hole
    // has four walls 2 m long and 0.5 m tall.
    const slab = new THREE.BoxGeometry(6, 0.5, 6).toNonIndexed()
    const n = slab.getAttribute('position').count
    slab.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0.5), 3))
    const cut = trimColumn(slab, SQUARE)
    const cap = capColumn(cut, SQUARE)
    expect(cap, 'something was cut, so something is capped').not.toBeNull()
    const capped = new THREE.BufferGeometry()
    capped.setAttribute('position', new THREE.Float32BufferAttribute(cap?.positions ?? [], 3))
    expect(areaOf(capped), 'four walls, 2 m by 0.5 m').toBeCloseTo(4, 5)
    // Facing in: toward the column's middle, the side the cut opened.
    const p = capped.getAttribute('position')
    for (let i = 0; i + 2 < p.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i)
      const tri = new THREE.Triangle(
        a,
        new THREE.Vector3().fromBufferAttribute(p, i + 1),
        new THREE.Vector3().fromBufferAttribute(p, i + 2),
      )
      const centre = tri.getMidpoint(new THREE.Vector3())
      expect(
        tri.getNormal(new THREE.Vector3()).dot(new THREE.Vector3(-centre.x, 0, -centre.z)),
      ).toBeGreaterThan(0)
      // And on a wall, at the slab's height.
      expect(Math.max(Math.abs(centre.x), Math.abs(centre.z))).toBeCloseTo(1, 5)
      expect(Math.abs(centre.y)).toBeLessThanOrEqual(0.25 + 1e-6)
    }
    // The colour is the cut faces' own.
    expect(cap?.colors.every((c) => Math.abs(c - 0.5) < 1e-6)).toBe(true)
    // A single sheet through the column is not a solid: one cut edge a
    // stretch, nothing to pair it with, and nothing is guessed.
    const sheet = new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2).toNonIndexed()
    sheet.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(
        new Array(sheet.getAttribute('position').count * 3).fill(1),
        3,
      ),
    )
    expect(capColumn(trimColumn(sheet, SQUARE), SQUARE)).toBeNull()
  })

  it("reads a square tube's inside and outside from its middle", () => {
    // A 4 m square tube, walls 0.5 m thick, inner faces turned in: two boxes.
    const outer = new THREE.BoxGeometry(5, 10, 5).toNonIndexed()
    const inner = new THREE.BoxGeometry(4, 10, 4).toNonIndexed()
    // The inner box's faces turned inward.
    const p = inner.getAttribute('position')
    for (let t = 0; t + 2 < p.count; t += 3) {
      const x = p.getX(t + 1)
      const y = p.getY(t + 1)
      const z = p.getZ(t + 1)
      p.setXYZ(t + 1, p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2))
      p.setXYZ(t + 2, x, y, z)
    }
    const tube = new THREE.BufferGeometry()
    const both = [...Array.from(outer.getAttribute('position').array), ...Array.from(p.array)]
    tube.setAttribute('position', new THREE.Float32BufferAttribute(both, 3))
    const s = sectionAt(tube, { x: 0, z: 0 }, 0.3, 8)
    // Azimuth 0 is +x: the wall's inside at 2, its outside at 2.5.
    expect(s.inner[0]).toBeCloseTo(2, 6)
    expect(s.outer[0]).toBeCloseTo(2.5, 6)
    // Azimuth 45 degrees is a corner.
    expect(s.inner[1]).toBeCloseTo(2 * Math.SQRT2, 6)
  })

  it('turns the outline into the world, one entry per world azimuth, never short of a corner', () => {
    // A reach with a spike at local azimuth 90 degrees (+z).
    const n = 360
    const reach = Array.from({ length: n }, (_, k) => (k === 90 ? 9 : 6))
    // The anchor turned a quarter about y: local +z points to world...
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    const world = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
    const worldAz = (Math.atan2(world.z, world.x) + Math.PI * 2) % (Math.PI * 2)
    const table = holeTableFor(reach, q, SHAFT_REACH_STEPS)
    const k = Math.round((worldAz / (Math.PI * 2)) * SHAFT_REACH_STEPS) % SHAFT_REACH_STEPS
    expect(table[k], "the spike lands at the anchor's turned azimuth").toBe(9)
    expect(Math.min(...table)).toBe(6)
  })

  it("bounds a LowPoly_Displace wave by its own expression's reach", () => {
    expect(waveReach({ amplitude: 4, noise: -1 })).toBe(4)
    expect(waveReach({ amplitude: 4, noise: 0.5 })).toBe(6)
    expect(waveReach({ amplitude: 4, noise: 0 })).toBe(4)
  })

  it('floors the shaft round the column, and refuses a reach that does not clear it', () => {
    const reach = Array.from({ length: 72 }, () => 3)
    const floor = hatchGeometry(reach, { x: 0, z: 0 }, 5, SQUARE, [0.1, 0.1, 0.1])
    expect(floor).not.toBeNull()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(floor?.positions ?? [], 3))
    // Both faces of a 72-gon of radius 3, less the 2 m square.
    const disc = 0.5 * 72 * 9 * Math.sin((Math.PI * 2) / 72)
    expect(areaOf(g)).toBeCloseTo(2 * (disc - 4), 3)
    const p = g.getAttribute('position')
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBe(5)
    expect(
      hatchGeometry(
        reach.map(() => 1.2),
        { x: 0, z: 0 },
        5,
        SQUARE,
        [0, 0, 0],
      ),
    ).toBeNull()
  })

  it('puts the hatch over the land and its jitter, or the sea, whichever is higher', () => {
    expect(hatchHeightOf({ land: 90, sea: null }, 0.8)).toBeCloseTo(90.8)
    expect(hatchHeightOf({ land: -35, sea: 105 }, 0.8)).toBe(105)
    expect(hatchHeightOf({ land: null, sea: null }, 0.8)).toBeNull()
  })
})

// ── the sea's shader takes the outline ──────────────────────────────────────

/** The shader's hole test, in TS. The GLSL below is pinned to its shape. */
interface Hole {
  readonly x: number
  readonly z: number
  readonly top: number
  readonly table: ArrayLike<number> | null
  readonly radius: number
}

const discards = (hole: Hole, w: THREE.Vector3): boolean => {
  if (w.y >= hole.top) return false
  const dx = w.x - hole.x
  const dz = w.z - hole.z
  const r = Math.hypot(dx, dz)
  if (!hole.table) return r < hole.radius
  const n = hole.table.length
  let turn = Math.atan2(dz, dx) * (n / (Math.PI * 2))
  if (turn < 0) turn += n
  let k0 = Math.floor(turn)
  const along = turn - k0
  if (k0 >= n) k0 = 0
  const k1 = k0 + 1 >= n ? 0 : k0 + 1
  const a = hole.table[k0] as number
  const b = hole.table[k1] as number
  return r < a + (b - a) * along
}

describe('the sea takes the shaft outline (DEV-460)', () => {
  const compile = () => {
    const material = new THREE.MeshStandardMaterial()
    const water = applyWaterWaves(material, {
      live: true,
      direction: 0,
      frequency: 1,
      amplitude: 4,
      noise: -1,
      speed: 1,
    } as Parameters<typeof applyWaterWaves>[1])
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <begin_vertex>',
      fragmentShader:
        '#include <color_fragment>\n#include <normal_fragment_begin>\n#include <opaque_fragment>',
    }
    // biome-ignore lint/suspicious/noExplicitAny: three's hook signature is wider than we need
    ;(material.onBeforeCompile as any)(shader, null)
    return { water, shader, material }
  }

  it('declares the outline in the FRAGMENT prelude and reads it in the discard', () => {
    const { shader } = compile()
    expect(shader.fragmentShader).toContain(`uniform vec4 uShaftReach[${SHAFT_REACH_STEPS / 4}];`)
    expect(shader.vertexShader).not.toContain('uShaftReach')
    expect(shader.fragmentShader).toMatch(
      /if \(fromR < mix\(ff2ShaftReach\(k0\), ff2ShaftReach\(k1\), along\)\) discard;/,
    )
  })

  it('holds a given outline, bounds it, and is a circle without one', () => {
    const { water, shader, material } = compile()
    const bore = shader.uniforms.uShaftBore?.value as THREE.Vector4
    const reach = shader.uniforms.uShaftReach?.value as Float32Array
    const outline = Array.from({ length: SHAFT_REACH_STEPS }, (_, k) => 6 + (k % 4))
    water.setShaftBore(1, 2, 0, 100, outline)
    expect(bore.z, 'the bound is the widest entry').toBe(9)
    expect(Array.from(reach)).toEqual(outline)
    // Live on the bound, not on the radius handed in: `boot/app.ts` hands an
    // outline with radius 0, and the first browser run drew the sea straight
    // across the shaft because the define came off.
    expect(material.defines?.FF2_WATER_SHAFT, 'the bore is in the shader').toBe('')
    water.setShaftBore(1, 2, 6.78, 100)
    expect(bore.z).toBeCloseTo(6.78)
    expect(Array.from(reach).every((r) => Math.abs(r - 6.78) < 1e-5)).toBe(true)
    expect(() => water.setShaftBore(1, 2, 0, 100, [1, 2, 3])).toThrow()
  })
})

// ── the real rig ────────────────────────────────────────────────────────────

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

// biome-ignore lint/suspicious/noExplicitAny: the level JSON carries fields the types lag
type Json = any

/**
 * A mission's launch as `boot/app.ts` builds it — anchor at the spawn, the
 * elevator and the launch room on it, 2016's rig through the lift app.ts hands
 * it — and the sea's hole and the land's reveal as app.ts leaves them.
 * `sealed: false` is the lift before DEV-460 (DEV-443's cut alone), whose hole
 * is the generated bore about the ship.
 */
const launchOf = async (id: string, sealed: boolean) => {
  const level: Json = loadLevelJson(id)
  const launch = level.spawn.launch
  const anchor = new THREE.Group()
  anchor.position.fromArray(level.spawn.pos)
  anchor.quaternion.fromArray(level.spawn.quat)
  anchor.updateMatrixWorld(true)
  const elevator = createElevator({
    platform: launch.platform,
    shaft: launch.shaft,
    rise: launch.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })
  anchor.add(elevator.object)
  const room = createHangar({
    spec: hangarSpecFor(),
    seed: 0x48414e47,
    furnished: false,
    title: '',
    subtitle: '',
    level: null,
  })
  anchor.add(room.object)
  const land = environmentTerrains(level.environment)
  const landJitter = terrainParams(land.land).randomOffset
  const oceanField = oceanFieldFor(level)
  const oceanSheet = (TERRAIN as Json)[level.environment]?.terrains?.ocean
  let groundTop: number | null = null
  let seal: LiftSeal | null = null
  const landSurface = {
    field: fieldFor(level),
    jitter: landJitter,
    map: mapFor(level.environment),
    // Anniversary's detail ring, the harder of the two looks.
    ring: { jitter: landJitter * ANNIVERSARY_RING_JITTER },
  }
  const lift = sealed
    ? cutShaftAtRim(
        sealLift(elevator, {
          hatchFor: (axis, radius) => {
            const top = worldTopIn(
              anchor.matrixWorld,
              axis,
              radius,
              landSurface,
              land.ocean && oceanField
                ? {
                    field: oceanField,
                    jitter: terrainParams(land.ocean).randomOffset,
                    displace: oceanSheet.displace,
                  }
                : null,
            )
            groundTop = top.land
            return hatchHeightOf(top, landJitter)
          },
          onSeal: (s) => {
            seal = s
          },
        }),
      )
    : cutShaftAtRim(elevator)
  const ok = await createLaunchArt({
    room: room.object,
    lift,
    alive: () => true,
    load: async () => parse(ROOM_FILE),
  }).ready
  expect(ok, `${id}: 2016's rig stood`).toBe(true)
  const s = seal as LiftSeal | null
  const at = s ? new THREE.Vector3(s.axis.x, 0, s.axis.z).applyMatrix4(anchor.matrixWorld) : null
  const hole: Hole = s
    ? {
        x: at?.x as number,
        z: at?.z as number,
        top: anchor.position.y + elevator.rimY,
        table: holeTableFor(s.reach, anchor.quaternion, SHAFT_REACH_STEPS),
        radius: 0,
      }
    : {
        x: anchor.position.x,
        z: anchor.position.z,
        top: anchor.position.y + elevator.rimY,
        table: null,
        radius: elevator.boreRadius,
      }
  // The land's reveal, as app.ts computes it for each lift.
  const deckDrop = (launch.platform.shipOffset[1] as number) - (launch.platform.offset[1] as number)
  let reveal: number
  if (s) {
    const drop = Math.max(deckDrop, -s.deckFoot)
    const inColumn = worldTopIn(anchor.matrixWorld, s.axis, columnRadiusOf(s), landSurface, null)
    reveal = landRevealFor({
      plugged: revealRiseFor(groundTop, drop, landJitter),
      column: revealRiseFor(inColumn.land, drop, landJitter),
      eyeClears: elevator.rimY - EYE.y,
    })
  } else {
    const field = fieldFor(level)
    let top = Number.NEGATIVE_INFINITY
    for (let ri = 0; ri <= 6; ri++)
      for (let ai = 0; ai < 24; ai++) {
        const r = (ri / 6) * elevator.boreRadius
        const a = (ai / 24) * Math.PI * 2
        top = Math.max(
          top,
          terrainHeightAt(
            field,
            anchor.position.x + Math.cos(a) * r,
            -(anchor.position.z + Math.sin(a) * r),
          ),
        )
      }
    reveal = revealRiseFor(top - anchor.position.y, deckDrop, landJitter)
  }
  return {
    level,
    launch,
    anchor,
    elevator,
    seal: s,
    hole,
    reveal,
    landJitter,
    groundTop: groundTop as number | null,
  }
}

type Launch = Awaited<ReturnType<typeof launchOf>>

/**
 * What the rig draws at `rise`, in the anchor's frame, as one list of meshes
 * with the materials' own sides: the shaft (cut, trimmed, hatched and capped
 * where DEV-460 is in), and 2016's dish while the lift holds the ship. Only the
 * band of the shaft a sightline from `eyeY` can reach within `reach` metres.
 */
const occludersAt = (rig: Launch, rise: number, eyeY: number, reach = 40): THREE.Mesh[] => {
  const out: THREE.Mesh[] = []
  rig.elevator.setRise(rise)
  rig.elevator.object.updateMatrixWorld(true)
  const toAnchor = rig.anchor.matrixWorld.clone().invert()
  rig.elevator.object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (let n: THREE.Object3D | null = mesh; n && n !== rig.anchor; n = n.parent)
      if (!n.visible) return
    const g = mesh.geometry.clone().applyMatrix4(toAnchor.clone().multiply(mesh.matrixWorld))
    // Keep the band: triangles with a corner within `reach` of the eye's height.
    const keep: number[] = []
    const flat = g.index ? g.toNonIndexed() : g
    const fp = flat.getAttribute('position')
    for (let t = 0; t + 2 < fp.count; t += 3) {
      const ys = [fp.getY(t), fp.getY(t + 1), fp.getY(t + 2)]
      if (Math.min(...ys) > eyeY + reach || Math.max(...ys) < eyeY - reach) continue
      for (let k = 0; k < 3; k++) keep.push(fp.getX(t + k), fp.getY(t + k), fp.getZ(t + k))
    }
    const band = new THREE.BufferGeometry()
    band.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3))
    band.computeBoundingSphere()
    const side = (mesh.material as THREE.Material).side
    out.push(new THREE.Mesh(band, new THREE.MeshBasicMaterial({ side })))
  })
  for (const m of out) m.updateMatrixWorld(true)
  return out
}

/** The eyes at `rise`, anchor frame: both of them, and a lean each way. */
const eyesAt = (rise: number): THREE.Vector3[] =>
  (
    [
      [-0.032, 0, 0],
      [0.032, 0, 0],
      [-0.2, 0.1, 0],
      [0.2, 0.1, 0],
      [0, 0.1, -0.2],
      [0, 0.1, 0.2],
    ] as const
  ).map(([dx, dy, dz]) => new THREE.Vector3(EYE.x + dx, EYE.y + rise + dy, EYE.z + dz))

/** Directions over the sphere, `step` degrees apart. */
const sphere = (step: number): THREE.Vector3[] => {
  const out: THREE.Vector3[] = []
  for (let el = -90 + step / 2; el < 90; el += step)
    for (let az = 0; az < 360; az += step) {
      const e = (el * Math.PI) / 180
      const a = (az * Math.PI) / 180
      out.push(new THREE.Vector3(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)))
    }
  return out
}

const RAYS = sphere(6)

/** Looking down, eight degrees apart: where anything under a floor would be seen from. */
const RAYS_DOWN = sphere(8).filter((d) => d.y < -0.05)

/** Sea surfaces relative to the eye: from a hand's breadth to four metres, either side. */
const SEA_OFFSETS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2, 3, 4].flatMap((d) => [d, -d])

/**
 * The sea, seen from the ride: for each eye and each ray, where the ray meets a
 * sea surface at any of `heights` (anchor frame) BEFORE it meets the rig. From
 * inside the shaft every such point is inside it, so the hole must cut it; from
 * over the rim, a ray that meets nothing of the rig is looking at the open sea,
 * so the hole must NOT cut it.
 */
const seaSeen = (rig: Launch, rise: number, heights: readonly number[]) => {
  const eyes = eyesAt(rise).slice(0, 2)
  const occluders = occludersAt(rig, rise, rise, 24)
  const ray = new THREE.Raycaster()
  const rimY = rig.elevator.rimY
  let flooded = 0
  let opened = 0
  let rays = 0
  const world = new THREE.Vector3()
  for (const eye of eyes) {
    for (const dir of RAYS) {
      rays++
      ray.set(eye, dir)
      ray.far = 60
      const hit = ray.intersectObjects(occluders, false)[0]
      const stop = hit ? hit.distance : Number.POSITIVE_INFINITY
      for (const h of heights) {
        if (Math.abs(dir.y) < 1e-6) continue
        const t = (h - eye.y) / dir.y
        if (t <= 0 || t >= stop || t > 60) continue
        world.copy(eye).addScaledVector(dir, t).applyMatrix4(rig.anchor.matrixWorld)
        const cut = h < rimY && discards(rig.hole, world)
        if (eye.y < rimY && !cut) flooded++
        if (eye.y >= rimY && !hit && cut) opened++
      }
    }
  }
  return { flooded, opened, rays }
}

describe.skipIf(!AVAILABLE)("2016's shaft keeps the world out (DEV-460)", () => {
  it("clears the lift's column: nothing of the shaft stands inside the dish's footprint", async () => {
    for (const sealed of [true, false]) {
      const rig = await launchOf('int_01_hoverJet', sealed)
      let shaft: THREE.Mesh | null = null
      let deck: THREE.Mesh | null = null
      rig.elevator.object.traverse((o) => {
        if (o.name === 'elevator-shaft-2016') shaft = o as THREE.Mesh
        if (o.name === 'elevator-deck-2016') deck = o as THREE.Mesh
      })
      const dish = footprintOf((deck as unknown as THREE.Mesh).geometry)
      const centre = centroidOf(dish)
      // A shaft point strictly inside the dish's footprint, at any height the
      // dish rides through, is something the dish (or the ship on it) passes
      // through: the catwalk at every segment's top came to 3.8 m of the axis.
      const p = (shaft as unknown as THREE.Mesh).geometry.getAttribute('position')
      const a = new THREE.Vector3()
      let inside = 0
      for (let i = 0; i < p.count; i += 3) {
        // Each triangle's corners and its centroid.
        const tri = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(p, i + k))
        a.copy(tri[0] as THREE.Vector3)
          .add(tri[1] as THREE.Vector3)
          .add(tri[2] as THREE.Vector3)
          .divideScalar(3)
        for (const v of [...tri, a]) {
          if (v.y < 12 || v.y > rig.elevator.rimY - 0.01) continue
          const r = Math.hypot(v.x - centre.x, v.z - centre.z)
          const edge = reachAlong(dish, centre, Math.atan2(v.z - centre.z, v.x - centre.x))
          if (r < edge - 0.01) inside++
        }
      }
      if (sealed) expect(inside, 'sealed: nothing inside the column').toBe(0)
      else expect(inside, 'the base: the catwalks stand in it (the witness)').toBeGreaterThan(0)
    }
    // And the ship on the dish is inside the dish's footprint, so what the
    // column clears for the dish it clears for the hull and the wings too: the
    // drawn art, placed as `game/flight.ts` places it (ART_POSITION, the yaw,
    // ART_SCALE), in the ship's frame — which at rest is the anchor's.
    const rig = await launchOf('int_01_hoverJet', true)
    const seal = rig.seal as LiftSeal
    const dishFoot = footprintOf(
      (rig.elevator.object.getObjectByName('elevator-deck-2016') as THREE.Mesh).geometry,
    )
    const centre = centroidOf(dishFoot)
    const points: Xz[] = []
    for (const f of [SHIP_MESH_EXTERIOR, SHIP_MESH_WINGS]) {
      const art = await parse(`public/${f}`)
      const holder = new THREE.Group()
      holder.position.copy(ART_POSITION)
      holder.rotation.y = SHIP_MODEL_YAW
      holder.scale.copy(ART_SCALE)
      holder.add(art)
      holder.updateMatrixWorld(true)
      const v = new THREE.Vector3()
      art.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const p = m.geometry.getAttribute('position')
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)
          points.push({ x: v.x, z: v.z })
        }
      })
    }
    let slack = Number.POSITIVE_INFINITY
    for (const q of hullXZ(points)) {
      const a = Math.atan2(q.z - centre.z, q.x - centre.x)
      slack = Math.min(
        slack,
        reachAlong(dishFoot, centre, a) - Math.hypot(q.x - centre.x, q.z - centre.z),
      )
    }
    expect(slack, 'the ship stands inside its dish, with room').toBeGreaterThan(0.5)
    expect(seal.column.length).toBeGreaterThan(2)
  }, 120_000)

  it('DEV-551: the catwalks the column cut are closed — from the ride, no catwalk shows its inside', async () => {
    // The claim is a SIGHTLINE, not the cap's own area: from eyes on the lift's
    // axis at the catwalk bands (a 12 m pitch, 16 m up the first), over the
    // sphere to 60 degrees either side of level, the first face met in the band
    // is never a BACK face — the inside of a solid. 2016's uncut shaft meets
    // none (its catwalks are closed); DEV-460's cut met hundreds (the open
    // shell it drew double-sided); capped, none. All three from one uncut
    // geometry, so the only difference is the cut and the cap.
    const rig = await launchOf('int_01_hoverJet', false)
    const shaft = rig.elevator.object.getObjectByName('elevator-shaft-2016') as THREE.Mesh
    const deck = rig.elevator.object.getObjectByName('elevator-deck-2016') as THREE.Mesh
    const foot = footprintOf(deck.geometry)
    const column = grownHull(foot, COLUMN_MARGIN)
    const axis = centroidOf(foot)
    const uncut = shaft.geometry
    const cut = trimColumn(uncut, column)
    const cap = capColumn(cut, column)
    expect(cap, 'the column cut something').not.toBeNull()
    const capped = appendTriangles(cut, cap as NonNullable<typeof cap>)
    const both = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    const backFaces = (g: THREE.BufferGeometry) => {
      const mesh = new THREE.Mesh(g, both)
      mesh.updateMatrixWorld(true)
      const ray = new THREE.Raycaster()
      const d = new THREE.Vector3()
      let back = 0
      let met = 0
      // Three of the eight bands (the first, a middle one, the last); the
      // segments repeat every 12 m, and a sweep of all eight takes 110 s.
      for (const band of [0, 3, 7]) {
        const y0 = 16 + band * 12
        for (const dy of [-1, 0, 1]) {
          const o = new THREE.Vector3(axis.x, y0 + dy, axis.z)
          for (let el = -60; el <= 60; el += 15)
            for (let az = 0; az < 360; az += 6) {
              const e = (el * Math.PI) / 180
              const a = (az * Math.PI) / 180
              d.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a))
              ray.set(o, d)
              ray.far = 30
              const hit = ray.intersectObject(mesh, false)[0]
              if (!hit?.face || Math.abs(hit.point.y - y0) > 1.5) continue
              met++
              if (hit.face.normal.dot(d) > 0) back++
            }
        }
      }
      return { back, met }
    }
    const before = backFaces(uncut)
    const open = backFaces(cut)
    const closed = backFaces(capped)
    console.info(
      `DEV-551 int_01: back faces met in the catwalk bands — uncut ${before.back}/${before.met}, ` +
        `cut ${open.back}/${open.met}, capped ${closed.back}/${closed.met}; ` +
        `${(cap?.positions.length ?? 0) / 9} cap triangles`,
    )
    // The premise, and the witness: the bands are met, and the cut alone opens them.
    expect(closed.met, 'sightlines meet the catwalks').toBeGreaterThan(500)
    expect(open.back, "DEV-460's cut, the witness: an open shell").toBeGreaterThan(50)
    // THE CLAIM.
    expect(closed.back, 'capped: no catwalk shows its inside').toBeLessThanOrEqual(before.back)
  }, 120_000)

  it('cuts the sea out of every corner of the shaft on the Simonet rides, and opens none outside it', async () => {
    // Two rigs turned differently (the outline is handed to the sea per WORLD
    // azimuth), the first at every stand and the second at three.
    for (const [id, rises] of [
      ['int_01_hoverJet', [86, 92, 98, 102.5, 104, 105.5]],
      ['adv_02_hoverJet', [92, 102.5, 105.5]],
    ] as const) {
      const sealedRig = await launchOf(id, true)
      const base = await launchOf(id, false)
      // Where the eye meets the sea: from under it, through it, to the rim and
      // past it.
      let floodedBase = 0
      for (const rise of rises) {
        const eyeY = rise + EYE.y
        // Close to the eye as well as away from it, so a sightline a few
        // degrees off level crosses one in every corner, near and far.
        const heights = SEA_OFFSETS.map((d) => eyeY + d).filter((h) => h < sealedRig.elevator.rimY)
        const sealed = seaSeen(sealedRig, rise, heights)
        expect(sealed.flooded, `${id} rise ${rise}: sea inside the shaft`).toBe(0)
        expect(sealed.opened, `${id} rise ${rise}: a hole in the open sea`).toBe(0)
        if (rise === 92) floodedBase += seaSeen(base, rise, heights).flooded
      }
      // The witness: the generated bore about the ship left the corners flooded.
      expect(floodedBase, `${id}: the base floods the corners`).toBeGreaterThan(0)
    }
  }, 600_000)

  it('shows nothing under the hatch once the lift has plugged it, on every rig', async () => {
    const LIFTS = [
      'int_01_hoverJet',
      'adv_02_hoverJet',
      'hoverJet_kauai_beg',
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
      'int_02_hoverJet',
      'adv_01_hoverJet',
    ]
    for (const id of LIFTS) {
      const rig = await launchOf(id, true)
      const seal = rig.seal as LiftSeal
      expect(seal.hatchY, `${id}: a hatch`).not.toBeNull()
      const hatchY = seal.hatchY as number
      const sealRise = seal.sealRise as number
      // The switches happen under it: where the hatch is the LAND's, the land
      // comes on no earlier than the plug — or than just before the eye clears
      // the rim, where that is first (`int_02` on Anniversary); where it is the
      // sea's, the land never reaches the shaft's foot at all. And the sea's
      // hole closes at the plug, by the top of the ride.
      const landLine = rig.groundTop === null ? null : rig.groundTop + rig.landJitter
      const eyeClears = rig.elevator.rimY - EYE.y
      if (landLine !== null && landLine >= hatchY - 1e-6) {
        expect(
          rig.reveal,
          `${id}: the land waits for the plug, or the eye at the rim`,
        ).toBeGreaterThanOrEqual(Math.min(sealRise, eyeClears - REVEAL_LEAD) - 1e-6)
      } else {
        expect(landLine ?? -Infinity, `${id}: no land in the shaft`).toBeLessThan(12)
      }
      expect(sealRise, `${id}: plugged by the top`).toBeLessThanOrEqual(rig.launch.rise + 1e-6)
      // And the land is on before the eye clears the rim, so no missing chunk
      // shows from the top (DEV-106's order).
      expect(rig.reveal + EYE.y, `${id}: land on before the eye clears the rim`).toBeLessThan(
        rig.elevator.rimY,
      )
      // From the land's reveal or the plug, whichever is first, to the
      // release, looking down: no sightline reaches under the hatch inside the
      // shaft. Before the plug the lift's column is open round the dish, and
      // with the land on, what is under the hatch is the ground. "Inside" is
      // enclosed: a horizontal ray out from the point meets the shaft's wall.
      const occ0 = occludersAt(rig, rig.launch.rise, rig.launch.rise)
      const wall = new THREE.Raycaster()
      const enclosed = (q: THREE.Vector3) =>
        [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
          const a = (k / 8) * Math.PI * 2
          wall.set(q, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
          wall.far = 20
          return wall.intersectObjects(occ0, false).length > 0
        })
      const q = new THREE.Vector3()
      const leaksFrom = (eyes: readonly THREE.Vector3[], occ: THREE.Mesh[]): number => {
        let leaks = 0
        const ray = new THREE.Raycaster()
        for (const eye of eyes) {
          for (const dir of RAYS_DOWN) {
            ray.set(eye, dir)
            ray.far = 80
            const hit = ray.intersectObjects(occ, false)[0]
            const t = (hatchY - 0.05 - eye.y) / dir.y
            if (t <= 0 || (hit && hit.distance < t)) continue
            q.copy(eye).addScaledVector(dir, t)
            if (Math.hypot(q.x - seal.axis.x, q.z - seal.axis.z) > 12) continue
            if (enclosed(q)) leaks++
          }
        }
        return leaks
      }
      let held = 0
      const landHatch = landLine !== null && landLine >= hatchY - 1e-6
      const from = landHatch ? Math.min(sealRise, rig.reveal) : sealRise
      for (const rise of [from, sealRise, (sealRise + rig.launch.rise) / 2, rig.launch.rise]) {
        held += leaksFrom(eyesAt(rise).slice(0, 4), occludersAt(rig, rise, rise, 14))
      }
      expect(held, `${id}: sightlines under the hatch (at ${hatchY.toFixed(2)})`).toBe(0)
      // Released: the deck goes, and the lid closes its column. From the seat
      // as it leaves, and from over the shaft head, as a chase view or a lap
      // coming back past the start sees it.
      rig.elevator.setReleased(true)
      const top = rig.launch.rise
      const over = [
        ...eyesAt(top).slice(0, 2),
        new THREE.Vector3(seal.axis.x, rig.elevator.rimY + 6, seal.axis.z + 8),
        new THREE.Vector3(seal.axis.x + 8, rig.elevator.rimY + 10, seal.axis.z),
        new THREE.Vector3(seal.axis.x, rig.elevator.rimY + 25, seal.axis.z),
      ]
      const released = leaksFrom(over, occludersAt(rig, top, top + 10, 30))
      rig.elevator.setReleased(false)
      expect(released, `${id}: sightlines under the hatch once released`).toBe(0)
    }
  }, 600_000)

  it('stands the hatch over the highest ground inside the shaft, read independently', async () => {
    for (const id of [
      'rookie_01_hoverJet',
      'hoverJet_kauai_beg',
      'int_02_hoverJet',
      'adv_01_hoverJet',
    ]) {
      const rig = await launchOf(id, true)
      const seal = rig.seal as LiftSeal
      const field = fieldFor(rig.level)
      const map = mapFor(rig.level.environment)
      const rgb = { r: 0, g: 0, b: 0 }
      // The ground as the finest land draws it: the height MAP (Anniversary's
      // detail ring draws off it at 4 m), and the collision field beside it.
      const groundAt = (wx: number, wz: number): number => {
        const sx = wx
        const sz = -wz
        map.sample(
          (sx - field.originX) / (field.scaleX || 1) / field.terrainSize,
          (sz - field.originZ) / (field.scaleZ || 1) / field.terrainSize,
          rgb,
        )
        const fromMap =
          field.originY + grayscale(rgb.r, rgb.g, rgb.b) * field.terrainHeight * (field.scaleY || 1)
        return Math.max(fromMap, terrainHeightAt(field, sx, sz))
      }
      // Every point of the shaft's inside, from horizontal raycasts at the
      // hatch's height against the drawn shaft — not the section the code read.
      const occ = occludersAt(rig, 0, seal.hatchY as number, 2)
      const ray = new THREE.Raycaster()
      let top = Number.NEGATIVE_INFINITY
      const v = new THREE.Vector3()
      for (let k = 0; k < 120; k++) {
        const a = (k / 120) * Math.PI * 2
        const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a))
        ray.set(new THREE.Vector3(seal.axis.x, (seal.hatchY as number) - 0.5, seal.axis.z), dir)
        ray.far = 20
        const wall = ray.intersectObjects(occ, false)
        const far = wall.length ? (wall.at(-1) as THREE.Intersection).distance : 0
        for (let s = 0; s <= far; s += 0.25) {
          v.set(seal.axis.x + dir.x * s, 0, seal.axis.z + dir.z * s).applyMatrix4(
            rig.anchor.matrixWorld,
          )
          top = Math.max(top, groundAt(v.x, v.z) - rig.anchor.position.y)
        }
      }
      expect(
        seal.hatchY as number,
        `${id}: hatch over the ground and its jitter`,
      ).toBeGreaterThanOrEqual(top + rig.landJitter - 0.05)
      // And when the land comes on, the deck's foot is over the ground inside
      // the lift's column, the one ground the hatch does not cover: a disc
      // round the axis that holds the whole column, every 0.25 m.
      const reach = columnRadiusOf(seal)
      let inColumn = Number.NEGATIVE_INFINITY
      for (let x = -reach; x <= reach; x += 0.25)
        for (let z = -reach; z <= reach; z += 0.25) {
          if (Math.hypot(x, z) > reach) continue
          v.set(seal.axis.x + x, 0, seal.axis.z + z).applyMatrix4(rig.anchor.matrixWorld)
          inColumn = Math.max(inColumn, groundAt(v.x, v.z) - rig.anchor.position.y)
        }
      expect(
        rig.reveal + seal.deckFoot,
        `${id}: the deck's foot over the ground in its column at the reveal`,
      ).toBeGreaterThanOrEqual(inColumn + rig.landJitter - 0.05)
    }
  }, 600_000)
})

describe.skipIf(AVAILABLE)(
  "2016's shaft keeps the world out — the rig or the maps are not hydrated",
  () => {
    it('says so, rather than passing quietly', () => {
      expect(
        AVAILABLE,
        `${ROOM_FILE} or the terrain maps are missing: run pnpm assets:pull to test DEV-460's seal`,
      ).toBe(false)
    })
  },
)
