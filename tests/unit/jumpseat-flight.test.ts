// tests/unit/jumpseat-flight.test.ts — the seam, and the content it reads.
//
// `src/sim/jumpseat.ts` has the physics and its own test file. This one covers
// the two decisions `game/jumpseat-flight.ts` makes by READING THE LEVEL, which
// is where a stale extractor field can put the ship 2.7 km from the course:
//
//   1. which marker the seat spawns at — `markerUsedAtLoad`, not `spawn`
//   2. how long the countdown is — `Trigger_EnableJumpShip`, not an elevator
//
// Plus the vehicle field itself, because until this session all six JumpSeat
// missions flew a HoverJet and nothing in the suite noticed.
//
// The level JSONs are imported directly, exactly as `autopilot.test.ts` and
// `ai-racer.test.ts` do — the generated trees ARE the port.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { buildJumpSeatArt, type JumpSeatArtParts } from '@/game/jumpseat-art'
import {
  JUMPSEAT_EYE,
  JUMPSEAT_FEET,
  JUMPSEAT_LEG_SPECS,
  markerFor,
  startSpecFor,
} from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'
import { startTotalSeconds } from '@/sim/jumpseat'
import { legFootLocal } from '@/sim/jumpseat-legs'
import adv01 from '../../content/levels/adv_01_jumpSeat.json'
import adv02 from '../../content/levels/adv_02_jumpSeat.json'
import int01Jet from '../../content/levels/int_01_hoverJet.json'
import int01 from '../../content/levels/int_01_jumpSeat.json'
import int02 from '../../content/levels/int_02_jumpSeat.json'
import rookie01 from '../../content/levels/rookie_01_jumpSeat.json'
import rookie02 from '../../content/levels/rookie_02_jumpSeat.json'

const LEVELS: readonly [string, Level][] = [
  ['rookie_01_jumpSeat', rookie01 as unknown as Level],
  ['rookie_02_jumpSeat', rookie02 as unknown as Level],
  ['int_01_jumpSeat', int01 as unknown as Level],
  ['int_02_jumpSeat', int02 as unknown as Level],
  ['adv_01_jumpSeat', adv01 as unknown as Level],
  ['adv_02_jumpSeat', adv02 as unknown as Level],
]

const distance = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

describe('the six JumpSeat missions', () => {
  it('all say they are JumpSeat missions', () => {
    // The whole reason `loadFlight` now dispatches. Seven missions fly the
    // HoverJet and these six do not.
    for (const [id, level] of LEVELS) {
      expect(`${id}:${level.vehicle}`).toBe(`${id}:jumpseat`)
    }
    expect((int01Jet as unknown as Level).vehicle).toBe('hoverjet')
  })

  it('all load at the RESPAWN marker', () => {
    // `Level.respawning` is serialised 1 in all six scenes and `Level.cs:287-294`
    // branches on it, so `SinglePlayerRespawnPosition` is where the ship appears.
    for (const [id, level] of LEVELS) {
      const named = (level as unknown as { markerUsedAtLoad?: string }).markerUsedAtLoad
      expect(`${id}:${named}`).toBe(`${id}:respawn`)
      expect(markerFor(level)).toBe(level.respawn)
    }
  })
})

describe('the elevator fields are a HoverJet rig, and the seam ignores them', () => {
  it('no longer calls the DECOY rig int_01\u2019s spawn \u2014 the two markers now agree', () => {
    // **This test used to assert the bug.** It said *"spawns int_01 at the
    // marker 2.78 KM from the one the JSON calls spawn"* and checked that the
    // two were more than 2 km apart, because that gap was the fingerprint:
    // `int_01_jumpSeat.spawn` was a scene-baked copy of
    // `PlayerStart_ElevatorShaft_Photon`, the HOVERJET decoy CLAUDE.md warns
    // about, while 2016 starts you at `levelOffset/playerstart_jumpSeat`.
    //
    // DEV-109 fixed the extractor rather than the symptom: `Level.respawning` is
    // serialised 1 in all thirteen scenes, so `Level.cs:287-294` reads
    // `SinglePlayerRespawnPosition` and the spawn field is dead YAML. The two
    // markers are now ONE POSE, and the gap is 0.
    //
    // The seam was never wrong — the ship already loaded at the respawn marker,
    // which is why this mission flew 6/6 gold with the bug in it. What was wrong
    // was everything that reads `spawn` and is NOT the ship: the launch room
    // (DEV-094 §3's *"terrain surface running through its walls"* — it was the
    // wrong room, not a badly placed one) and the spawn clearing.
    const level = int01 as unknown as Level
    const apart = distance(level.spawn.pos as number[], level.respawn.pos as number[])
    expect(apart).toBeCloseTo(0, 6)
    expect(markerFor(level)).toBe(level.respawn)
    // The DIRECTION of the fix, stated so a regression that moves the respawn
    // marker to the decoy instead would not pass: the surviving pose is the one
    // on the Simonet hillside, not the one 2.7 km away. `playerstart_jumpSeat`
    // sits at Unity (1537.406, 297.552, -1031.674) under `levelOffset`; in three
    // space that is x +1530.23 and z +1034.72, and the decoy was at x -1179.69.
    expect(level.spawn.pos[0] as number).toBeGreaterThan(1000)
    expect(level.spawn.pos[2] as number).toBeGreaterThan(1000)
  })

  it('no longer starts rookie_02 at the BOTTOM of a shaft it cannot ride', () => {
    // The same disease in miniature, and the same fix. This mission's two
    // markers are on one rig rather than two, so the gap was vertical: the
    // `spawn` field named the lift SEAT, 109.43 m below `respawn_position`, and
    // a JumpSeat cannot call `StartLaunch()` — it would have begun the run
    // inside a shaft it never rides, which is DEV-094's
    // `rookie_02_jumpSeat desert -103.25 (no rig)` with a cause attached.
    //
    // Now one pose. Asserted as an equality plus the DIRECTION, because "the
    // drop is 0" alone would also pass if both markers had been moved to the
    // bottom of the shaft, which is the wrong fix for the right number.
    const level = rookie02 as unknown as Level
    const drop = (level.respawn.pos[1] as number) - (level.spawn.pos[1] as number)
    expect(drop).toBeCloseTo(0, 6)
    expect(markerFor(level)).toBe(level.respawn)
    // 186.69 m, the respawn marker's own altitude — the surviving pose is the
    // HIGH one. The seat it used to take was at 77.27.
    expect(level.spawn.pos[1] as number).toBeGreaterThan(150)
  })

  it('is not fooled by whatever launchKind currently says', () => {
    // `tools/extract/level.mjs` decides `launchKind` from whether the SCENE
    // materialises a `LaunchElevator`, which is a property of the scene and not
    // of the ship; a fix is in flight. This asserts the seam's behaviour is
    // independent of it in BOTH states, so the fix landing cannot break this and
    // the fix not landing cannot break the game.
    for (const [id, level] of LEVELS) {
      const kind = level.spawn.launchKind
      expect(['elevator', 'direct', null, undefined]).toContain(kind)
      // Whatever it says, the marker is the respawn one and the countdown is
      // 7.5 s. `rideElevator()` on this vehicle is a documented no-op.
      expect(`${id}:${markerFor(level) === level.respawn}`).toBe(`${id}:true`)
      expect(startTotalSeconds(startSpecFor(level))).toBeCloseTo(7.5, 9)
    }
  })
})

describe('the countdown', () => {
  it('is 3.5 s of triggerDelay plus a 4-count, on every mission', () => {
    for (const [id, level] of LEVELS) {
      const spec = startSpecFor(level)
      expect(`${id}:${spec.triggerDelaySeconds}`).toBe(`${id}:3.5`)
      expect(`${id}:${spec.countdownSeconds}`).toBe(`${id}:4`)
    }
  })

  it('prefers the level JSON the moment the extractor emits it', () => {
    // Hard rule 6: content is data. The fallback in `jumpseat-flight.ts` exists
    // only until `spawn.enableJumpSeatDelay` lands, and this is the test that
    // says the handover works without another edit.
    const level = {
      spawn: { enableJumpSeatDelay: 2, enableJumpSeatCount: 3 },
    } as unknown as Level
    expect(startTotalSeconds(startSpecFor(level))).toBeCloseTo(5, 9)
  })
})

/**
 * Headless stand-ins for the three GLB scenes `loadJumpSeatArt` fetches, so the
 * LEG tests below need no asset on disk: an empty body and shell (the painter
 * only touches meshes), and a box the size of `hexTile`'s prism where the strut
 * goes. The real files are measured in `jumpseat-art.test.ts`, guarded.
 */
const fakeParts = (): JumpSeatArtParts => {
  const strut = new THREE.Group()
  const prism = new THREE.Mesh(new THREE.BoxGeometry(1.9021, 0.5, 1.809))
  prism.name = 'pCylinder1'
  prism.position.y = 0.25
  strut.add(prism)
  return { body: new THREE.Group(), shell: new THREE.Group(), strut }
}
const buildArt = () => buildJumpSeatArt(fakeParts())

describe('the art', () => {
  it('puts the eye on the head collider, not somewhere plausible', () => {
    // `collider_head` `&174574` exists because a head is there. Three space, so
    // z is negated relative to the sheet's ship-root (Unity) frame.
    const head = JUMPSEAT.shipCollisionColliders.find((c) => c.name === 'collider_head')
    expect(head).toBeDefined()
    expect(JUMPSEAT_EYE.y).toBe(head?.centerInShipRootSpace.y)
    expect(JUMPSEAT_EYE.z).toBe(-(head?.centerInShipRootSpace.z as number))
    // And it is a metre and a half up — a seated pilot, not the origin.
    expect(JUMPSEAT_EYE.y).toBeGreaterThan(1.5)
  })

  it('stands on the measured footprint, with the fore/aft asymmetry intact', () => {
    // The turn-indicator shape of check, carried through the three-space
    // conversion this time: a mirror in x preserves the 3.00 m beam perfectly
    // and a sign error in z collapses the -1.48 / +1.56 asymmetry.
    expect(JUMPSEAT_FEET).toHaveLength(4)
    const xs = JUMPSEAT_FEET.map((f) => f.x)
    const zs = JUMPSEAT_FEET.map((f) => f.z)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3.0, 6)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(3.04, 6)
    // Unity's aft leg is at z = -1.48, so in three space the LONG end is -1.56.
    expect(Math.min(...zs)).toBeCloseTo(-1.56, 6)
    expect(Math.max(...zs)).toBeCloseTo(1.48, 6)
    expect(Math.abs(Math.min(...zs))).not.toBeCloseTo(Math.max(...zs), 3)
  })
})

// ── the legs MOVE ─────────────────────────────────────────────────────────
//
// Matt's whole note is that the legs sag and cushion, so a leg that does not
// move on screen has not shipped the feature however right the physics is.
// These are the headless half of that: the drawn leg is measured against the
// simulated one, and against the leg's own capsule, in metres.
//
// DEV-433 changed what a drawn leg IS. Until then it was one prism laid along
// the sim's hinge-to-foot line, so its far end was the sim's foot by
// construction. Now it is 2016's: a group at the leg rigidbody's frame, with
// the prefab's TWO struts at their own transforms inside it, turned about the
// prefab's own hinge by the sim's angle. So the drawn foot is the capsule's
// bottom cap carried through that frame, and it is measured against the sim's
// foot rather than equal to it by construction. Since DEV-530 the sim builds
// its legs from the same capsule's frame, so the two agree to the sheet's
// rounding (below); until then the sim reconstructed its hinge from two
// collider centres and stood 1 to 20 cm off the capsule.
//
// Every assertion is a DISTANCE. The title jets flew backwards through a whole
// session of Matt looking at the screen because every e2e assertion on it was
// about positions and counts, all of which were correct — so these measure the
// thing that would be wrong, which is where the far end of the leg IS.

describe('the legs', () => {
  /** Every leg group named `leg_*`, in spec order. */
  const legsOf = (art: THREE.Object3D): THREE.Object3D[] =>
    JUMPSEAT_LEG_SPECS.map((spec, i) => {
      const m = art.getObjectByName(`leg_${i}_${spec.name}`)
      if (!m) throw new Error(`no leg for ${spec.name}`)
      return m
    })

  /** The leg's own capsule: the enabled `CapsuleCollider` on its rigidbody. */
  const capsuleOf = (name: string): { height: number; radius: number } => {
    const leg = JUMPSEAT.legs.find((l) => l.name === name)
    const c = JUMPSEAT.colliders.find(
      (k) => k.name === name && k.parentPath === leg?.parentPath && k.enabled,
    )
    if (!c || !('height' in c.effective) || !('radius' in c.effective)) {
      throw new Error(`no capsule on ${name}`)
    }
    return { height: c.effective.height, radius: c.effective.radius }
  }

  /**
   * Points in the leg's own frame, THREE space (Unity's leg-local with z
   * negated). The capsule is centred on the leg's origin along its y
   * (`direction: 1`), so its caps are ±height/2 on y; the hinge is the
   * HingeJoint's own `m_Anchor`, and a second point on the hinge LINE is
   * `anchor + axis`.
   */
  const local = (name: string) => {
    const joint = JUMPSEAT.legs.find((l) => l.name === name)
    if (!joint) throw new Error(`no joint ${name}`)
    const { height } = capsuleOf(name)
    const a = joint.anchor
    const x = joint.axis
    return {
      foot: new THREE.Vector3(0, -height / 2, 0),
      top: new THREE.Vector3(0, height / 2, 0),
      hinge: new THREE.Vector3(a.x, a.y, -a.z),
      hinge2: new THREE.Vector3(a.x + x.x, a.y + x.y, -(a.z + x.z)),
    }
  }

  /** A leg-local point, in the ship's frame (three space) as the leg is now posed. */
  const at = (leg: THREE.Object3D, p: THREE.Vector3): THREE.Vector3 => {
    leg.updateMatrix()
    return p.clone().applyMatrix4(leg.matrix)
  }
  const drawnFoot = (leg: THREE.Object3D, i: number): THREE.Vector3 =>
    at(leg, local(JUMPSEAT_LEG_SPECS[i]?.name as string).foot)
  const simFoot = (i: number, angle: number): THREE.Vector3 => {
    const spec = JUMPSEAT_LEG_SPECS[i]
    if (!spec) throw new Error(`no spec ${i}`)
    const f = legFootLocal({ x: 0, y: 0, z: 0 }, spec, angle)
    // Ship-root (Unity) -> three space is the z-flip and nothing else.
    return new THREE.Vector3(f.x, f.y, -f.z)
  }

  /** Distance from `p` to the infinite line through `a` and `b`. */
  const toLine = (p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number => {
    const d = b.clone().sub(a).normalize()
    const v = p.clone().sub(a)
    return v.sub(d.multiplyScalar(v.dot(d))).length()
  }

  /** Closest approach of two segments, by bisection-free sampling (exact enough at 1 mm). */
  const segmentGap = (
    p1: THREE.Vector3,
    q1: THREE.Vector3,
    p2: THREE.Vector3,
    q2: THREE.Vector3,
  ): number => {
    let best = Number.POSITIVE_INFINITY
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    for (let i = 0; i <= 200; i++) {
      a.lerpVectors(p1, q1, i / 200)
      for (let j = 0; j <= 200; j++)
        best = Math.min(best, a.distanceTo(b.lerpVectors(p2, q2, j / 200)))
    }
    return best
  }

  /**
   * A strut's two axis ends — the prism's bounding-box centre line — in the
   * SHIP's frame, through the whole hierarchy as it is posed: a strut hung
   * anywhere but inside its leg's frame would not ride the swing.
   */
  const strutEnds = (strut: THREE.Object3D): [THREE.Vector3, THREE.Vector3] => {
    const mesh = strut as THREE.Mesh
    mesh.geometry.computeBoundingBox()
    const b = mesh.geometry.boundingBox as THREE.Box3
    const cx = (b.min.x + b.max.x) / 2
    const cz = (b.min.z + b.max.z) / 2
    return [
      new THREE.Vector3(cx, b.min.y, cz).applyMatrix4(strut.matrixWorld),
      new THREE.Vector3(cx, b.max.y, cz).applyMatrix4(strut.matrixWorld),
    ]
  }

  it('turns each leg about 2016’s OWN hinge line, and by exactly the angle the sim holds', () => {
    // Two points on the HingeJoint's line — its anchor, and one axis-length
    // along it — must not move, whatever the angle: the turn is about that line
    // and no other. And a point OFF the line moves along a chord of exactly the
    // sim's angle, 2·r·sin(|θ|/2), r its distance from the line. Geometry,
    // whichever sign the axis arrived with.
    const art = buildArt()
    const legs = legsOf(art.object)
    art.setLegAngles([0, 0, 0, 0])
    const rest = legs.map((leg, i) => {
      const p = local(JUMPSEAT_LEG_SPECS[i]?.name as string)
      return { h1: at(leg, p.hinge), h2: at(leg, p.hinge2), foot: at(leg, p.foot) }
    })
    const angles = [-0.0156, 0.12, -0.31, 0.44]
    art.setLegAngles(angles)
    for (const [i, leg] of legs.entries()) {
      const p = local(JUMPSEAT_LEG_SPECS[i]?.name as string)
      const r = rest[i] as { h1: THREE.Vector3; h2: THREE.Vector3; foot: THREE.Vector3 }
      // A micrometre: the rounding here is 1e-9, so anything past this is a real drift.
      expect(at(leg, p.hinge).distanceTo(r.h1)).toBeLessThan(1e-6)
      expect(at(leg, p.hinge2).distanceTo(r.h2)).toBeLessThan(1e-6)
      const radius = toLine(r.foot, r.h1, r.h2)
      const chord = 2 * radius * Math.sin(Math.abs(angles[i] as number) / 2)
      expect(at(leg, p.foot).distanceTo(r.foot)).toBeCloseTo(chord, 6)
    }
    art.dispose()
  })

  it('moves each drawn foot the way the sim moves its own: +θ lifts, −θ drops', () => {
    // The sim defines the sign (`+θ LIFTS the foot`, sim/jumpseat-legs.ts).
    // Since DEV-530 the two hinges are one hinge, so the directions agree to a
    // cosine of 1 less the sheet's rounding — not merely 0.9897, which is what
    // the reconstructed hinge gave on front_l, and not a sign apart, which is
    // what a hinge turned the wrong way would give.
    const art = buildArt()
    const legs = legsOf(art.object)
    art.setLegAngles([0, 0, 0, 0])
    const rest = legs.map((leg, i) => drawnFoot(leg, i))
    for (const angle of [-0.4, -0.0156, 0.0784, 0.44, 0.9]) {
      art.setLegAngles([angle, angle, angle, angle])
      for (const [i, leg] of legs.entries()) {
        const moved = drawnFoot(leg, i).sub(rest[i] as THREE.Vector3)
        const simMoved = simFoot(i, angle).sub(simFoot(i, 0))
        const cos = moved.dot(simMoved) / (moved.length() * simMoved.length())
        expect(`${i}@${angle}:${cos > 0.99999}`).toBe(`${i}@${angle}:true`)
        expect(Math.sign(moved.y)).toBe(Math.sign(angle))
      }
    }
    art.dispose()
  })

  it('stands each drawn foot where the sim’s is (DEV-530)', () => {
    // The drawn foot is the capsule's bottom cap through the prefab's frame;
    // the sim's is `contactDistance` down a strut built from the SAME capsule's
    // composed frame (DEV-530), so the two are one point. Until DEV-530 the sim
    // reconstructed its strut from the leg's origin and its lowest collider
    // centre — on `front_l` a disabled `foot_00` box of a different size from
    // the other three legs' — and this test pinned the miss (metres, at rest):
    //
    //     back_l 0.064 · back_r 0.064 · front_l 0.197 · front_r 0.011
    //
    // Matt, 2026-09-29: *"fix plz"*. What is left is the sheet's 1e-6 rounding
    // of the frame, carried 2.5 m. A frame placed with the wrong handedness
    // puts a foot metres away.
    const art = buildArt()
    const legs = legsOf(art.object)
    art.setLegAngles([0, 0, 0, 0])
    for (const [i, leg] of legs.entries()) {
      const name = JUMPSEAT_LEG_SPECS[i]?.name as string
      expect(drawnFoot(leg, i).distanceTo(simFoot(i, 0)), name).toBeLessThan(1e-4)
    }
    // And they stay together over the whole range the gear uses: the drawn leg
    // turns about the prefab's hinge, the sim's about the same line.
    for (const angle of [-0.4, -0.0316, 0.0784, 0.1772, 0.44, 0.9]) {
      art.setLegAngles([angle, angle, angle, angle])
      for (const [i, leg] of legs.entries()) {
        expect(drawnFoot(leg, i).distanceTo(simFoot(i, angle))).toBeLessThan(1e-4)
      }
    }
    art.dispose()
  })

  it('moves the drawn foot a MEASURABLE distance for the angles the sim uses', () => {
    // The sag is 0.89° and the parked squat is 4-10°, so this is the check that
    // "the legs move" is a statement about pixels rather than about state: a
    // 3.9 cm droop and a 19 cm compression, 2.52 m from the hinge.
    const art = buildArt()
    const legs = legsOf(art.object)

    art.setLegAngles([0, 0, 0, 0])
    const rest = legs.map(drawnFoot)
    art.setLegAngles([-0.0156, -0.0156, -0.0316, -0.0316]) // the airborne sag
    const sagged = legs.map(drawnFoot)
    art.setLegAngles([0.0784, 0.0765, 0.1772, 0.0922]) // the parked squat
    const squat = legs.map(drawnFoot)

    for (let i = 0; i < 4; i++) {
      const a = rest[i] as THREE.Vector3
      const b = sagged[i] as THREE.Vector3
      const c = squat[i] as THREE.Vector3
      expect(a.distanceTo(b)).toBeGreaterThan(0.03) // sag: 3.9 cm or more
      expect(a.distanceTo(c)).toBeGreaterThan(0.18) // squat: 19 cm or more
      expect(b.y).toBeLessThan(a.y) // sagging drops the foot
      expect(c.y).toBeGreaterThan(a.y) // squatting lifts it
    }
    art.dispose()
  })

  it('keeps every foot on its own side of the ship at every angle', () => {
    // The z-flip is applied to the frame, so a handedness slip cannot swing one
    // leg into another's quadrant without this seeing it. Four legs in a
    // rectangle is precisely the symmetric geometry orientation bugs hide in.
    const art = buildArt()
    for (const angle of [-0.4, -0.0156, 0, 0.3, 0.9]) {
      art.setLegAngles([angle, angle, angle, angle])
      for (const [i, spec] of JUMPSEAT_LEG_SPECS.entries()) {
        const foot = drawnFoot(legsOf(art.object)[i] as THREE.Object3D, i)
        expect(Math.sign(foot.x)).toBe(Math.sign(spec.pivot.x))
        // three space negates z, so an aft Unity leg is a +z three leg.
        expect(Math.sign(foot.z)).toBe(-Math.sign(spec.pivot.z))
      }
    }
    art.dispose()
  })

  it('moves enough PIXELS to be seen from the pilot’s own eye', () => {
    // DEV-044: the title jets flew backwards through a whole session of Matt
    // looking at the screen because they were four pixels across. A thing too
    // small to see has not been reviewed, it has been rendered — so the leg
    // travel is measured as an ANGLE subtended at `JUMPSEAT_EYE`, which is the
    // quantity a headset actually resolves.
    //
    // A Quest 3 eye is ~2064 px over ~104°, so about 20 px per degree.
    const art = buildArt()
    const legs = legsOf(art.object)

    art.setLegAngles([0, 0, 0, 0])
    const rest = legs.map(drawnFoot)
    art.setLegAngles([-0.0156, -0.0156, -0.0316, -0.0316])
    const sagged = legs.map(drawnFoot)
    art.setLegAngles([0.0784, 0.0765, 0.1772, 0.0922])
    const squat = legs.map(drawnFoot)

    // The FRONT pair is the pair in shot: the pilot faces three-space -z, the
    // front feet are ahead of the eye and the back feet are behind it.
    const front = [2, 3]
    for (const i of front) {
      const a = rest[i] as THREE.Vector3
      expect(a.z).toBeLessThan(JUMPSEAT_EYE.z - 1) // ahead of the pilot
      const range = a.distanceTo(JUMPSEAT_EYE)
      expect(range).toBeLessThan(6)
      const sagDeg = (Math.atan2(a.distanceTo(sagged[i] as THREE.Vector3), range) * 180) / Math.PI
      const squatDeg = (Math.atan2(a.distanceTo(squat[i] as THREE.Vector3), range) * 180) / Math.PI
      // ~0.8° of droop in the air — 16 px, subtle but present — and 2.8° to
      // 5.4° when the gear takes the weight, which is 55 to 110 px of travel.
      // Neither is four pixels.
      expect(`${i}:sag>${sagDeg > 0.5}`).toBe(`${i}:sag>true`)
      expect(`${i}:squat>${squatDeg > 2.5}`).toBe(`${i}:squat>true`)
    }
    art.dispose()
  })

  it('has four legs, TWO hexTile struts in each — the eight 2016 draws — and no foot pads', () => {
    // DEV-433: the port drew one per leg. 2016's `foot_00` groups are
    // `m_IsActive: 0` on every leg — the stand-in's pads were its own invention,
    // and they are gone with it.
    const art = buildArt()
    const legs = legsOf(art.object)
    let struts = 0
    let pads = 0
    art.object.traverse((o: THREE.Object3D) => {
      if (o.name.startsWith('strut_')) struts++
      if (o.name.includes('foot')) pads++
    })
    expect(legs).toHaveLength(4)
    expect(struts).toBe(8)
    for (const leg of legs) {
      expect(
        leg.children.filter((c) => c.name.startsWith('strut_')),
        leg.name,
      ).toHaveLength(2)
    }
    expect(pads).toBe(0)
    expect(() => {
      art.dispose()
    }).not.toThrow()
  })

  it('hangs each leg’s two struts where the prefab does, measured on the leg’s own capsule', () => {
    // The oracle is Unity-native and in the same prefab: the leg's own
    // `CapsuleCollider` (h 3.04, r 0.16, centred on the leg's origin, along its
    // y). Measured off the prefab, in the leg's frame:
    //
    //   * the LEG strut's lower end is the capsule's bottom cap — 4.5 cm off on
    //     the back pair, 11 cm on the front;
    //   * the DAMPER's upper end is on the capsule's axis ABOVE the hinge — 10 cm
    //     off it on the back pair, 1 cm on the front (1.66 and 2.30 m up);
    //   * and the two MEET, at a knee 0.7 to 0.9 m off the axis: 1.1 cm between
    //     the segments on the back pair, 0.2 cm on the front.
    //
    // The prefab authors each strut separately; the knee is two independent
    // transforms agreeing, which a strut hung at the wrong transform cannot
    // fake. The derived single strut this replaces had no damper to measure.
    const art = buildArt()
    for (const pose of [
      [0, 0, 0, 0],
      [0.3, -0.2, 0.9, -0.4],
    ]) {
      art.setLegAngles(pose)
      art.object.updateMatrixWorld(true)
      for (const [i, leg] of legsOf(art.object).entries()) {
        const name = JUMPSEAT_LEG_SPECS[i]?.name as string
        // The capsule's points, carried into the ship's frame by the leg as posed.
        const q = local(name)
        const p = {
          foot: at(leg, q.foot),
          top: at(leg, q.top),
          hinge: at(leg, q.hinge),
          up: at(leg, q.top).sub(at(leg, q.foot)).normalize(),
        }
        const [s1, s2] = leg.children.filter((c) => c.name.startsWith('strut_'))
        if (!s1 || !s2) throw new Error(`${name}: not two struts`)
        const e1 = strutEnds(s1)
        const e2 = strutEnds(s2)
        // The leg strut is the one that reaches furthest DOWN the leg.
        const down = (v: THREE.Vector3) => -v.clone().sub(p.hinge).dot(p.up)
        const lowest = (e: THREE.Vector3[]) => Math.max(...e.map(down))
        const [legEnds, damperEnds] = lowest(e1) > lowest(e2) ? [e1, e2] : [e2, e1]
        const foot = down(legEnds[0]) > down(legEnds[1]) ? legEnds[0] : legEnds[1]
        expect(foot.distanceTo(p.foot), `${name} foot`).toBeLessThan(0.12)
        const up = down(damperEnds[0]) < down(damperEnds[1]) ? damperEnds[0] : damperEnds[1]
        expect(toLine(up, p.foot, p.top), `${name} damper on the axis`).toBeLessThan(0.12)
        // Above the hinge ALONG the leg, which is not world-up once it swings.
        expect(up.clone().sub(p.hinge).dot(p.up), `${name} damper above the hinge`).toBeGreaterThan(
          0.5,
        )
        expect(
          segmentGap(legEnds[0], legEnds[1], damperEnds[0], damperEnds[1]),
          `${name} knee`,
        ).toBeLessThan(0.03)
      }
    }
    art.dispose()
  })
})
