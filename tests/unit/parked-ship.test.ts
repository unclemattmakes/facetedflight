// tests/unit/parked-ship.test.ts — the jet parked in the menu room faces the
// chair (DEV-139).
//
// Matt, 2026-09-16: *"the ship should be rotated to face me."* Twelve frames
// from the seat settled which way the mesh's nose points (`PARKED_SHIP_YAW`'s
// comment has the sweep). This pins what the frames showed as GEOMETRY, the
// way the orientation lesson asks: the end of the hull nearer the eye is the
// end that TAPERS, and it is much nearer than the other end. No quaternion is
// named — a yaw assertion would be the belief written twice (DEV-040).
//
// The ship is the real `hoverjet-exterior.glb`, parsed off disk the way
// `medal-art.test.ts` parses the logo. Gitignored (rule 7), so the skip is loud.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { createHangar, PARKED_SHIP_YAW, seatEyeLocal } from '@/render/hangar'
import { hangarSpecFor } from '@/sim/hangar'

const GLB = 'public/assets/ships/hoverjet-exterior.glb'
const available = fs.existsSync(GLB)

const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

interface Ends {
  /** World position of the hull's two extremities along its own long axis. */
  readonly a: THREE.Vector3
  readonly b: THREE.Vector3
  /** Max |cross-axis| of the hull in the outer 15 % of each end — how wide it is there. */
  readonly widthA: number
  readonly widthB: number
  readonly box: THREE.Box3
}

/**
 * The two ends of the hull, found without naming an axis: the ship's local
 * axis with the greatest extent is the hull, whichever letter it is.
 */
const endsOf = (ship: THREE.Object3D): Ends => {
  ship.updateWorldMatrix(true, true)
  const locals: THREE.Vector3[] = []
  const worlds: THREE.Vector3[] = []
  const box = new THREE.Box3()
  ship.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const p = mesh.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < p.count; i++) {
      const w = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld)
      worlds.push(w)
      box.expandByPoint(w)
      locals.push(ship.worldToLocal(w.clone()))
    }
  })
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity)
  const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  for (const l of locals) {
    lo.min(l)
    hi.max(l)
  }
  const extent = hi.clone().sub(lo)
  const axis: 'x' | 'z' = extent.x >= extent.z ? 'x' : 'z'
  const cross: 'x' | 'z' = axis === 'x' ? 'z' : 'x'
  let iA = 0
  let iB = 0
  for (let i = 0; i < locals.length; i++) {
    if ((locals[i] as THREE.Vector3)[axis] < (locals[iA] as THREE.Vector3)[axis]) iA = i
    if ((locals[i] as THREE.Vector3)[axis] > (locals[iB] as THREE.Vector3)[axis]) iB = i
  }
  const len = extent[axis]
  const aEdge = lo[axis] + len * 0.15
  const bEdge = hi[axis] - len * 0.15
  let widthA = 0
  let widthB = 0
  for (const l of locals) {
    if (l[axis] < aEdge) widthA = Math.max(widthA, Math.abs(l[cross]))
    if (l[axis] > bEdge) widthB = Math.max(widthB, Math.abs(l[cross]))
  }
  return { a: worlds[iA] as THREE.Vector3, b: worlds[iB] as THREE.Vector3, widthA, widthB, box }
}

describe.skipIf(!available)('the parked jet, from the chair', () => {
  const spec = hangarSpecFor()

  const room = async () => {
    const ship = await parse()
    // The launch-room build: shell, strips, lamp and the parked ship, no DOM.
    const art = createHangar({
      spec,
      seed: 0x48414e47,
      furnished: false,
      parkedShip: ship,
      title: '',
      subtitle: '',
      level: null,
    })
    art.object.updateWorldMatrix(true, true)
    const local = seatEyeLocal(spec)
    const eye = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(art.object.matrixWorld)
    const parked = art.object.getObjectByName('hangar-parked-ship')
    expect(parked, 'the ship is parked under its name').toBeDefined()
    return { art, eye, ship: parked as THREE.Object3D }
  }

  it('puts the NOSE — the end that tapers — metres nearer the eye than the tail', async () => {
    const { eye, ship } = await room()
    const ends = endsOf(ship)
    // Which end is nearer is a fact about the frame; which end tapers is a fact
    // about the mesh. The claim is that they are the SAME end.
    const dA = eye.distanceTo(ends.a)
    const dB = eye.distanceTo(ends.b)
    const near = dA < dB ? ends.widthA : ends.widthB
    const far = dA < dB ? ends.widthB : ends.widthA
    expect(near, 'the near end is the narrower one: a nose, not three nozzles').toBeLessThan(far)
    // Measured on the sweep at 285: 4.85 m to the nose, 11.66 m to the tail. A
    // side view would put both within a metre or two of each other.
    expect(Math.abs(dA - dB), 'end-on, not side-on').toBeGreaterThan(4)
    expect(Math.min(dA, dB), 'the nose is within reach of the chair').toBeLessThan(6.5)
  })

  it('has the nose as the nearest part of the whole ship to the eye', async () => {
    const { eye, ship } = await room()
    const ends = endsOf(ship)
    const nose = eye.distanceTo(ends.a) < eye.distanceTo(ends.b) ? ends.a : ends.b
    // Nearest vertex of the entire hull to the eye is within a wingspan's
    // fraction of the nose tip — nothing else (a wingtip, a fin) leads it.
    let nearest = Infinity
    ship.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!mesh.isMesh) return
      const p = mesh.geometry.attributes.position as THREE.BufferAttribute
      const w = new THREE.Vector3()
      for (let i = 0; i < p.count; i++) {
        w.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld)
        nearest = Math.min(nearest, eye.distanceTo(w))
      }
    })
    expect(eye.distanceTo(nose) - nearest).toBeLessThan(0.6)
  })

  it('stands on the floor at the room’s origin', async () => {
    const { ship } = await room()
    const ends = endsOf(ship)
    const centre = ends.box.getCenter(new THREE.Vector3())
    expect(Math.hypot(centre.x, centre.z), 'over the axis').toBeLessThan(1.5)
    expect(ends.box.min.y, 'wheels on the floor').toBeGreaterThan(spec.floorY - 0.6)
    expect(ends.box.min.y).toBeLessThan(spec.floorY + 1.2)
  })

  it('is a quarter view, not dead-on: the yaw is 15 degrees off head-on', () => {
    // The one place the number is named, and only as a relationship to the
    // head-on frame the sweep photographed at 270.
    const offHeadOn = ((PARKED_SHIP_YAW * 180) / Math.PI - 270 + 360) % 360
    expect(offHeadOn).toBeGreaterThan(0)
    expect(offHeadOn).toBeLessThanOrEqual(30)
  })
})

describe.skipIf(available)('hoverjet-exterior.glb is not on disk', () => {
  it('so the facing tests above were SKIPPED, not passed', () => {
    expect(available).toBe(false)
  })
})
