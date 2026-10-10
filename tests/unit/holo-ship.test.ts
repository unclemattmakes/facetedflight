// tests/unit/holo-ship.test.ts — the aircraft on the aircraft table (DEV-142).
//
// Matt, in a headset: *"menu ui showing ship selection should show the ships,
// not terrain, on the holo table."*
//
// ── What is asserted, and what deliberately is not ────────────────────────
//
// The orientation lesson: **test the geometry, not the rotation.** There is no
// quaternion in this file and no "the nose points at −z". Four of this port's
// bugs have been orientation bugs, three of them caught by Matt from a
// screenshot rather than by the suite, and every one of them would have
// survived an assertion that wrote a belief down twice.
//
// What is measured instead is what a player can see is wrong:
//
//   * the model FITS the table — inside the rim, not over it;
//   * it stands ON the table — nothing below the lift plane, so no aircraft
//     half-swallowed by a plinth;
//   * it is the size the fraction says, whatever size the mesh is;
//   * the turntable is a TURNTABLE — the silhouette's height does not change
//     as it goes round, which is the geometric way of saying it yaws and does
//     not tumble, and is true without knowing which way it faces;
//   * the prototype is not consumed, because two tables and a page turn share
//     one loaded mesh.
//
// §1 drives all of that with a synthetic prototype whose origin is a long way
// from its geometry — the JumpSeat's case, whose art root sits 1.4 m above its
// feet — because an implementation that assumed the origin was the floor would
// pass every test built from a centred cube.
//
// §2 asks the same questions of the two SHIPPED aircraft. Those GLBs are
// gitignored (hard rule 7), so it skips where they are absent and §3 is the
// loud counterpart that stops the skip being a silent pass.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { buildJumpSeatArt } from '@/game/jumpseat-art'
import { createHoloShip } from '@/render/holo-ship'

/** `TABLE_RIM_RADIUS` in `render/hangar.ts`, and what the room passes. */
const RIM_RADIUS = 0.26
const DISC = RIM_RADIUS * 2

const GLB = {
  hoverjet: 'public/assets/ships/hoverjet-exterior.glb',
  body: 'public/assets/ships/jumpseat-body.glb',
  shell: 'public/assets/ships/jumpseat-shell.glb',
  strut: 'public/assets/ships/jumpseat-strut.glb',
} as const
const available = Object.values(GLB).every((p) => fs.existsSync(p))

/** Parse a GLB straight off disk, so no server or fetch is involved. */
const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/**
 * A prototype shaped like an aircraft and placed like a difficult one: 3.2 long,
 * 2.0 across, 0.8 tall, and sitting 1.4 m BELOW its own origin, which is where
 * the JumpSeat's art hangs relative to its rigidbody.
 */
const awkwardPrototype = (): THREE.Object3D => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.8, 3.2))
  mesh.position.set(0.3, -1.4, -0.5)
  const root = new THREE.Group()
  root.add(mesh)
  return root
}

/** The model's world box, with the group's own placement composed in. */
const boxOf = (object: THREE.Object3D): THREE.Box3 => {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

/**
 * The box with the turntable's yaw taken back out.
 *
 * `createHoloShip` starts at a RANDOM yaw, like the medals, so the plain
 * world-space AABB of a placed ship is the box of a rotated body — bigger than
 * the model along both horizontal axes, by an amount that changes every run.
 * The first draft of this file measured that and asserted it against the
 * model's own size, which is a test that fails for a reason nothing is wrong
 * with. Anything about the MESH is measured here; anything about the disc it
 * sweeps goes through `ship.reach`, which is yaw-invariant by construction.
 */
const spinnerOf = (ship: { readonly object: THREE.Group }): THREE.Object3D => {
  const spinner = ship.object.children.find((c) => c.name.startsWith('holo-ship-spinner-'))
  if (!spinner) throw new Error('no spinner under the ship')
  return spinner
}

const unspunBoxOf = (ship: { readonly object: THREE.Group }): THREE.Box3 => {
  const spinner = spinnerOf(ship)
  const spun = spinner.rotation.y
  spinner.rotation.y = 0
  // The MODEL's box, not the group's. There are no lights in the group any
  // more (DEV-188 moved them to the room), but the spinner is still the right
  // thing to measure: it is what turns, and a box taken with the turn undone
  // is the one a fit claim can be made against.
  const box = boxOf(spinner)
  spinner.rotation.y = spun
  ship.object.updateMatrixWorld(true)
  return box
}

describe('§1 the display case, on a prototype that is hard to place', () => {
  it('sizes the SWEPT DISC to the table fraction, uniformly', () => {
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    const size = unspunBoxOf(ship).getSize(new THREE.Vector3())
    // The rule: the disc it turns inside is the diameter it was given, whatever
    // shape the footprint is. The prototype is 2.0 x 3.2 on the floor, so its
    // swept diameter is hypot(2.0, 3.2) = 3.772 units of mesh.
    expect(ship.reach * 2).toBeCloseTo(DISC, 6)
    const scale = DISC / Math.hypot(2.0, 3.2)
    // Uniform: the 2.0 : 0.8 : 3.2 proportions all survive it, so nothing is
    // stretched to fill the table.
    expect(size.x).toBeCloseTo(2.0 * scale, 6)
    expect(size.y).toBeCloseTo(0.8 * scale, 6)
    expect(size.z).toBeCloseTo(3.2 * scale, 6)
    expect(ship.span).toBeCloseTo(3.2 * scale, 6)
  })

  it('fits inside the rim, centred on the spin axis', () => {
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    // The mesh is offset 0.3 and −0.5 from the prototype's origin; if that
    // offset survived, the model would hang off one side of the table — and,
    // being on a turntable, would orbit the middle of it.
    const centre = unspunBoxOf(ship).getCenter(new THREE.Vector3())
    expect(centre.x).toBeCloseTo(0, 6)
    expect(centre.z).toBeCloseTo(0, 6)
    // And the disc it sweeps is the rim, to the metre it was asked for — which
    // is `reach`, not the AABB: the AABB of a body at a random yaw is not the
    // footprint.
    expect(ship.reach).toBeCloseTo(RIM_RADIUS, 6)
    // Which is only worth asserting if the drawn box never escapes it either.
    // A whole turn, exhaustively, because it is cheap (CLAUDE.md: prefer the
    // sweep where one is cheap).
    for (let i = 0; i < 48; i += 1) {
      ship.update(0.25)
      const box = boxOf(spinnerOf(ship))
      const corner = Math.max(Math.hypot(box.max.x, box.max.z), Math.hypot(box.min.x, box.min.z))
      // sqrt(2) because an AABB corner is the worst case of a disc of `reach`.
      expect(corner, `yaw step ${i}`).toBeLessThanOrEqual(ship.reach * Math.SQRT2 + 1e-9)
    }
  })

  it('stands ON the table: nothing below the lift plane, and it is not floating away', () => {
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    const box = boxOf(spinnerOf(ship))
    // The 1.4 m the prototype's geometry sits below its origin is exactly the
    // thing that would drive the model through the plinth.
    expect(box.min.y).toBeCloseTo(ship.bottom, 6)
    expect(ship.bottom).toBeGreaterThan(0)
    // A hover, not a launch: under a tenth of the model's own length.
    expect(ship.bottom).toBeLessThan(ship.span * 0.1)
  })

  it('turns on a turntable — the silhouette does not change height', () => {
    // *Test the geometry, not the rotation.* A model that tumbled, or that had
    // been laid on its side by a stray axis, would change how tall it is as it
    // went round. This is true without knowing which way it faces.
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    const first = boxOf(spinnerOf(ship))
    const heights: number[] = []
    const floors: number[] = []
    for (let i = 0; i < 24; i += 1) {
      // A second of frame time per step, which is ~27.5 degrees.
      ship.update(1)
      const box = boxOf(spinnerOf(ship))
      heights.push(box.max.y - box.min.y)
      floors.push(box.min.y)
    }
    for (const [i, h] of heights.entries()) {
      expect(h, `height at step ${i}`).toBeCloseTo(first.max.y - first.min.y, 6)
      expect(floors[i] as number, `floor at step ${i}`).toBeCloseTo(first.min.y, 6)
    }
    // It did move, which is the control: all of the above is also true of a
    // model that never turns at all.
    expect(spinnerOf(ship).rotation.y).not.toBeCloseTo(0, 3)
  })

  it('leaves the prototype alone, and two ships do not share a transform', () => {
    // One loaded mesh serves both aircraft tables and every page turn. Trap 19:
    // where a thing is shared across instances, the guard is *step a SECOND one
    // and assert the first did not move.*
    const prototype = awkwardPrototype()
    const before = boxOf(prototype).clone()
    const a = createHoloShip(prototype, 'a', DISC)
    const b = createHoloShip(prototype, 'b', DISC)
    b.update(3)
    const after = boxOf(prototype)
    expect(after.min.toArray()).toEqual(before.min.toArray())
    expect(after.max.toArray()).toEqual(before.max.toArray())
    // And a's placement is untouched by b having turned.
    const box = boxOf(spinnerOf(a))
    expect(box.max.y - box.min.y).toBeCloseTo(a.span * (0.8 / 3.2), 6)
  })

  it('disposing one table does not empty the prototype the other is using', () => {
    const prototype = awkwardPrototype()
    const a = createHoloShip(prototype, 'a', DISC)
    const b = createHoloShip(prototype, 'b', DISC)
    a.dispose()
    // The geometry is shared by design — `dispose` drops the clone and nothing
    // else. If it disposed, b would be drawing an empty buffer and the JumpSeat
    // table would go blank the first time you paged back from the HoverJet.
    const size = boxOf(spinnerOf(b)).getSize(new THREE.Vector3())
    expect(size.x).toBeGreaterThan(0)
    expect(size.y).toBeGreaterThan(0)
    expect(size.z).toBeGreaterThan(0)
  })

  it('survives an empty prototype rather than writing NaN into the scene', () => {
    // A load that resolved to nothing. The table should be bare, not poisoned:
    // one NaN in a transform propagates through every matrix under it.
    const ship = createHoloShip(new THREE.Group(), 'nothing', DISC)
    ship.object.updateMatrixWorld(true)
    for (const n of ship.object.matrixWorld.elements) expect(Number.isFinite(n)).toBe(true)
    expect(Number.isFinite(ship.span)).toBe(true)
  })

  // ── the lamps are a DESCRIPTION, not a light (DEV-188) ──────────────────
  //
  // This aircraft used to carry its own key and fill, and that made the menu
  // scene's `numPointLights` a function of which STEP the player was on —
  // `numPointLights` being a field of every lit material's program cache key,
  // the room then recompiled four programs on the first press. The fix is that
  // `render/hangar.ts` owns one fixed pair per table for the room's whole life.
  //
  // The property that keeps it fixed is *this function adds no lights*, and it
  // is worth a test of its own because it is invisible: a `PointLight` put back
  // here would look right, work, and cost a compile storm nobody would connect
  // to it. The e2e spec (`tests/e2e/menu-light-compile.spec.ts`) is the gate on
  // the ROOM; this is the gate on the display case.

  it('adds no lights — the count belongs to the room, not to the ship', () => {
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    let lights = 0
    ship.object.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++
    })
    expect(lights, 'a holo ship is geometry; the lamps are the room’s').toBe(0)
  })

  it('describes a key and a fill that are placed off its own measured size', () => {
    // Not the intensities, which are a solve with its own note — the GEOMETRY,
    // which is what a wrong answer shows as. The key is up and to one side of
    // the model and the fill is opposite it, both inside the lamp `distance`
    // that keeps them off the next table 30 degrees round the arc.
    const ship = createHoloShip(awkwardPrototype(), 'test', DISC)
    const { key, fill } = ship.lamps
    expect(key.x, 'the key is on the +x side').toBeGreaterThan(0)
    expect(fill.x, 'and the fill opposes it').toBeLessThan(0)
    expect(Math.sign(key.z), 'in z as well as x').toBe(-Math.sign(fill.z))
    // Both above the model's floor, which is `bottom` — a lamp under the table
    // lights the underside of an aircraft and nothing else.
    expect(key.y).toBeGreaterThan(ship.bottom)
    expect(fill.y).toBeGreaterThan(ship.bottom)
    // And both actually reach the model. A `PointLight` with a `distance`
    // windows to nothing at that range, so a lamp standing further off than its
    // own cutoff is a lamp that is off — the shape DEV-043 describes, which
    // looks identical at any intensity you care to type.
    expect(Math.hypot(key.x, key.y - ship.bottom, key.z)).toBeLessThan(key.distance)
    expect(Math.hypot(fill.x, fill.y - ship.bottom, fill.z)).toBeLessThan(fill.distance)
    // Deliberately NOT "it does not reach the next table". The cutoff is three
    // spans — 1.16 m for the HoverJet against tables about 0.8 m apart on the
    // arc — so it does reach, and falls off as 1/r²; the claim this file can
    // honestly make is that the lamp is scaled to the MODEL, which the test
    // below makes.
    //
    // The key is the key: it is the brighter of the two at the model.
    expect(key.intensity).toBeGreaterThan(fill.intensity)
  })

  it('scales its lamps with the aircraft, so both sizes are lit the same way', () => {
    // The two shipped aircraft have completely different footprints, so a lamp
    // placement that was a constant would sit inside one of them. Every number
    // in the pair is a multiple of `span`, and this is the property that says
    // so without restating the multiples: double the mesh, double the offsets.
    const small = createHoloShip(awkwardPrototype(), 'small', DISC)
    const big = createHoloShip(awkwardPrototype(), 'big', DISC * 2)
    const ratio = big.span / small.span
    expect(ratio).toBeCloseTo(2, 6)
    expect(big.lamps.key.x / small.lamps.key.x).toBeCloseTo(ratio, 6)
    expect(big.lamps.key.distance / small.lamps.key.distance).toBeCloseTo(ratio, 6)
    expect(big.lamps.fill.x / small.lamps.fill.x).toBeCloseTo(ratio, 6)
  })
})

/**
 * The two aircraft AS THE ROOM GETS THEM — `boot/app.ts` hands `ships()` the
 * HoverJet's exterior GLB and `loadJumpSeatArt`'s assembled rig, and a test of
 * `jumpseat-body.glb` alone would be a test of a seat with no shell and no
 * legs. The shell is the longer half of the JumpSeat's footprint (5.85 against
 * the body's 3.47), so it is also the half that decides the scale.
 */
const shippedAircraft = async (): Promise<Record<string, THREE.Object3D>> => {
  const [hoverjet, body, shell, strut] = await Promise.all([
    parse(GLB.hoverjet),
    parse(GLB.body),
    parse(GLB.shell),
    parse(GLB.strut),
  ])
  return { hoverjet, jumpseat: buildJumpSeatArt({ body, shell, strut }).object }
}

describe.skipIf(!available)('§2 the two shipped aircraft stand on the table', () => {
  it('places both inside the rim and above the lift plane', async () => {
    for (const [vehicle, prototype] of Object.entries(await shippedAircraft())) {
      const ship = createHoloShip(prototype, vehicle, DISC)
      expect(ship.reach, `${vehicle} reach`).toBeCloseTo(RIM_RADIUS, 6)
      expect(unspunBoxOf(ship).min.y, `${vehicle} floor`).toBeCloseTo(ship.bottom, 6)
      expect(ship.bottom, `${vehicle} hover`).toBeGreaterThan(0)
    }
  })

  it('does not lay either of them on its side — the mesh keeps its proportions', async () => {
    // This file is a display CASE, and the thing it could get wrong about a
    // real mesh is swapping an axis. So the claim is NOT "an aircraft is longer
    // than it is tall" — which is true of the HoverJet (6.82 x 2.01 x 6.17, a
    // delta) and FALSE of the JumpSeat, a chair that is taller than it is long.
    // Asserting it cost a red run, and the run was right.
    //
    // What the case owes is that all three of the prototype's extents come
    // through scaled by ONE factor. Whatever `jumpseat-art.test.ts` and
    // DEV-139's sweep established about which way up these meshes are is then
    // still true on the table, without this file restating it.
    for (const [vehicle, prototype] of Object.entries(await shippedAircraft())) {
      const before = boxOf(prototype).getSize(new THREE.Vector3())
      const ship = createHoloShip(prototype, vehicle, DISC)
      const after = unspunBoxOf(ship).getSize(new THREE.Vector3())
      const scale = after.x / before.x
      expect(after.y / before.y, `${vehicle} y`).toBeCloseTo(scale, 6)
      expect(after.z / before.z, `${vehicle} z`).toBeCloseTo(scale, 6)
    }
  })
})

describe.skipIf(available)('§3 the ship meshes are not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})
