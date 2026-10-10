// tests/unit/spring-arm.test.ts — the third-person arm, measured. DEV-128.
//
// Every assertion here is about GEOMETRY or about a RELATIONSHIP, not about a
// pose I believe in: the orientation lesson (DEVIATIONS.md) is that a
// quaternion assertion is a belief written twice. A wall at 10 m has to stop
// the arm before 10 m whichever way the arm points; the horizon has to tilt by
// `rollFollow` TIMES the ship's own tilt, measured the same way on both; the
// lens term has to be exactly zero when the slider is off.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Edition, EditionThirdPerson } from '@/content/edition-schema'
import { FREE_LOOK_PITCH_LIMIT } from '@/input/look'
import {
  ARM_PITCH_LIMIT,
  clampArmPitch,
  clearFraction,
  createSpringArm,
  fovAddFor,
  type SurfaceHeightAt,
} from '@/render/spring-arm'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const anniversary = anniversaryJson as unknown as Edition
const classic = classicJson as unknown as Edition
const BLOCK: EditionThirdPerson = anniversary.render.thirdPerson

/** Open sea with no land: nothing to hit. */
const NO_SURFACE: SurfaceHeightAt = () => Number.NEGATIVE_INFINITY

/** A level ship at `p`, facing −z (three's forward). */
const ship = (x = 0, y = 100, z = 0) => ({
  shipPosition: new THREE.Vector3(x, y, z),
  shipQuaternion: new THREE.Quaternion(),
})

const input = (
  s: ReturnType<typeof ship>,
  dt = 1 / 60,
  surfaceHeightAt: SurfaceHeightAt | null = NO_SURFACE,
  look = { lookYaw: 0, lookPitch: 0 },
) => ({ ...s, ...look, dt, surfaceHeightAt })

/** The resting camera for a level ship facing −z: behind (+z) and above. */
const restingOffset = (block: EditionThirdPerson): THREE.Vector3 => {
  const pitch = THREE.MathUtils.degToRad(block.armPitchDeg)
  return new THREE.Vector3(
    block.pivotOffset[0],
    block.pivotOffset[1] + Math.sin(pitch) * block.armLength,
    block.pivotOffset[2] + Math.cos(pitch) * block.armLength,
  )
}

describe('the SHIPPED Anniversary arm, pinned (DEV-357)', () => {
  // Matt, 2026-09-24: "i'd love to be closer", then about two thirds. The one
  // place the value is written in a test, so moving it is an edit somebody
  // makes on purpose; every other assertion here reads BLOCK and follows it.
  it('is an 8 m arm with a 3.5 m lag cap, about 11.5 m at cruise', () => {
    expect(BLOCK.armLength).toBe(8)
    expect(BLOCK.maxLagMetres).toBe(3.5)
  })
})

describe('the first frame snaps, and the lag converges', () => {
  it('snaps to the resting pose on the first update', () => {
    const arm = createSpringArm()
    const s = ship()
    arm.update(BLOCK, input(s))
    const want = s.shipPosition.clone().add(restingOffset(BLOCK))
    expect(arm.position.distanceTo(want)).toBeLessThan(1e-6)
    expect(arm.armLength).toBe(BLOCK.armLength)
  })

  it('converges on a ship that has moved, at the preset time constant', () => {
    const arm = createSpringArm()
    arm.update(BLOCK, input(ship(0, 100, 0)))
    // The ship jumps sideways by most of the lag clamp — WITHIN it, which is
    // the premise, so the jump is a fraction of the preset rather than a number
    // of metres (it was 4 m against a 6 m clamp until DEV-357 made the clamp
    // 3.5) — and the pivot follows exponentially: after one time constant the
    // gap is 1/e of itself.
    const jump = BLOCK.maxLagMetres * 0.8
    const moved = ship(jump, 100, 0)
    const tau = BLOCK.positionLagSeconds
    const dt = tau / 100
    for (let i = 0; i < 100; i++) arm.update(BLOCK, input(moved, dt))
    const gapAfterTau = jump - arm.pivot.x
    expect(gapAfterTau).toBeGreaterThan(jump * Math.exp(-1) * 0.9)
    expect(gapAfterTau).toBeLessThan(jump * Math.exp(-1) * 1.1)
    // And it does converge: five time constants later it is at the ship.
    for (let i = 0; i < 500; i++) arm.update(BLOCK, input(moved, dt))
    expect(Math.abs(jump - arm.pivot.x)).toBeLessThan(0.05)
  })

  it('never lets the pivot trail the ship by more than maxLagMetres', () => {
    const arm = createSpringArm()
    arm.update(BLOCK, input(ship(0, 100, 0)))
    // A boost from rest: the ship is 100 m away one frame later.
    arm.update(BLOCK, input(ship(0, 100, -100)))
    const truePivot = new THREE.Vector3(0, 100 + BLOCK.pivotOffset[1], -100)
    expect(arm.pivot.distanceTo(truePivot)).toBeLessThanOrEqual(BLOCK.maxLagMetres + 1e-6)
  })

  it('is frame-rate independent: 60 Hz and 240 Hz land in the same place', () => {
    const a = createSpringArm()
    const b = createSpringArm()
    a.update(BLOCK, input(ship()))
    b.update(BLOCK, input(ship()))
    const moved = ship(3, 102, -5)
    for (let i = 0; i < 30; i++) a.update(BLOCK, input(moved, 1 / 60))
    for (let i = 0; i < 120; i++) b.update(BLOCK, input(moved, 1 / 240))
    expect(a.position.distanceTo(b.position)).toBeLessThan(0.02)
  })

  it('reset makes the next update snap again', () => {
    const arm = createSpringArm()
    arm.update(BLOCK, input(ship(0, 100, 0)))
    arm.reset()
    const far = ship(500, 100, 500)
    arm.update(BLOCK, input(far))
    expect(
      arm.position.distanceTo(far.shipPosition.clone().add(restingOffset(BLOCK))),
    ).toBeLessThan(1e-6)
  })
})

describe('the probe shortens the arm against the world — geometry, not belief', () => {
  it('stops short of a cliff behind the ship', () => {
    // A vertical wall inside the arm's reach: everything past it is 1 km of
    // rock. The ship faces −z, so the arm reaches back toward +z and into the
    // wall. Placed at a FRACTION of the arm, because the premise is "inside the
    // reach" — it was z = 10 against a 12.5 m arm, which an 8 m arm (DEV-357)
    // never touches.
    const wallZ = BLOCK.armLength * 0.8
    const wall: SurfaceHeightAt = (_x, z) => (z > wallZ ? 1000 : Number.NEGATIVE_INFINITY)
    const arm = createSpringArm()
    arm.update(BLOCK, input(ship(0, 100, 0), 1 / 60, wall))
    expect(arm.position.z).toBeLessThan(wallZ)
    expect(arm.armLength).toBeLessThan(BLOCK.armLength)
    expect(arm.armLength).toBeGreaterThanOrEqual(BLOCK.minArmLength)
    // And it is not timid: the lens sits within one probe step of the wall.
    expect(arm.position.z).toBeGreaterThan(wallZ - BLOCK.armLength / 32 - 0.05)
  })

  it('keeps probeRadius of clearance over a floor the arm would dip below', () => {
    // A flat floor at y = 0, a ship 2 m over it, and an arm authored to look
    // UP at the ship from below (negative armPitch): the far end would be
    // under the floor, and the probe has to stop it `probeRadius` above.
    const floor: SurfaceHeightAt = () => 0
    const block: EditionThirdPerson = { ...BLOCK, armPitchDeg: -20 }
    const arm = createSpringArm()
    arm.update(block, input(ship(0, 2, 0), 1 / 60, floor))
    expect(arm.position.y).toBeGreaterThanOrEqual(block.probeRadius - 0.05)
    expect(arm.armLength).toBeLessThan(block.armLength)
  })

  it('leaves the arm alone in clear air, and where there is no terrain at all', () => {
    const a = createSpringArm()
    a.update(BLOCK, input(ship(), 1 / 60, NO_SURFACE))
    expect(a.armLength).toBe(BLOCK.armLength)
    const b = createSpringArm()
    b.update(BLOCK, input(ship(), 1 / 60, null))
    expect(b.armLength).toBe(BLOCK.armLength)
  })

  it('never shortens below minArmLength, even inside a hillside', () => {
    const rock: SurfaceHeightAt = () => 1000
    const arm = createSpringArm()
    arm.update(BLOCK, input(ship(), 1 / 60, rock))
    expect(arm.armLength).toBe(BLOCK.minArmLength)
  })

  it('clearFraction measures the wall the same way from any direction', () => {
    // The same wall, approached along +z and along +x, gives the same distance.
    const from = new THREE.Vector3(0, 50, 0)
    const wallZ: SurfaceHeightAt = (_x, z) => (z > 7 ? 1000 : Number.NEGATIVE_INFINITY)
    const wallX: SurfaceHeightAt = (x) => (x > 7 ? 1000 : Number.NEGATIVE_INFINITY)
    const alongZ = clearFraction(from, new THREE.Vector3(0, 0, 1), 20, 1, wallZ)
    const alongX = clearFraction(from, new THREE.Vector3(1, 0, 0), 20, 1, wallX)
    expect(alongZ * 20).toBeCloseTo(7, 1)
    expect(alongX * 20).toBeCloseTo(alongZ * 20, 6)
  })
})

describe('the horizon tilts with a FRACTION of the bank', () => {
  /** Roll of an orientation, measured as the rise of its right-hand vector. */
  const tiltOf = (q: THREE.Quaternion): number =>
    Math.asin(new THREE.Vector3(1, 0, 0).applyQuaternion(q).y)

  it('tilts the camera by rollFollow × the ship’s own tilt, measured the same way', () => {
    const banked = {
      shipPosition: new THREE.Vector3(0, 100, 0),
      shipQuaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.4),
    }
    const arm = createSpringArm()
    // Converged: the rotation lag has had twenty time constants.
    for (let i = 0; i < 400; i++) arm.update(BLOCK, input(banked, BLOCK.rotationLagSeconds / 20))
    const shipTilt = tiltOf(banked.shipQuaternion)
    const cameraTilt = tiltOf(arm.quaternion)
    expect(Math.sign(cameraTilt)).toBe(Math.sign(shipTilt))
    expect(cameraTilt).toBeCloseTo(BLOCK.rollFollow * shipTilt, 2)
  })

  it('keeps world up with rollFollow 0, like the ?view=chase tool', () => {
    const banked = {
      shipPosition: new THREE.Vector3(0, 100, 0),
      shipQuaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7),
    }
    const arm = createSpringArm()
    arm.update({ ...BLOCK, rollFollow: 0 }, input(banked))
    expect(Math.abs(tiltOf(arm.quaternion))).toBeLessThan(1e-6)
  })

  it('follows the heading fully: a ship turned 90° puts the camera off its stern', () => {
    const turned = {
      shipPosition: new THREE.Vector3(0, 100, 0),
      // Yaw +90°: forward (−z) becomes −x, so astern is +x.
      shipQuaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI / 2,
      ),
    }
    const arm = createSpringArm()
    arm.update(BLOCK, input(turned))
    expect(arm.position.x).toBeGreaterThan(BLOCK.armLength * 0.9)
    expect(Math.abs(arm.position.z)).toBeLessThan(1e-6)
  })
})

describe('the lens term is on the comfort slider', () => {
  it('is EXACTLY zero at the slider’s minimum, at every speed', () => {
    for (const v of [0, 90, 120, 180, 240, 340, 500]) {
      expect(fovAddFor(BLOCK, v, 0)).toBe(0)
    }
  })

  it('opens with speed at full, and half as much at light', () => {
    expect(fovAddFor(BLOCK, 90, 1)).toBe(0)
    const full = fovAddFor(BLOCK, 340, 1)
    expect(full).toBeGreaterThan(0)
    expect(fovAddFor(BLOCK, 340, 0.5)).toBeCloseTo(full / 2, 10)
    // Monotonic along the curve: faster is never narrower.
    let last = -1
    for (const v of [0, 90, 120, 180, 240, 340, 500]) {
      const add = fovAddFor(BLOCK, v, 1)
      expect(add).toBeGreaterThanOrEqual(last)
      last = add
    }
  })

  it('is zero on Classic, whose flag is off', () => {
    expect(classic.render.thirdPerson.enabled).toBe(false)
    expect(fovAddFor(classic.render.thirdPerson, 340, 1)).toBe(0)
  })

  it('is smaller than the cockpit lens term at the top, by design', () => {
    // The cockpit's flatFov is NOT on the slider (DEV-093) and this one is; a
    // third person that opened MORE than the cockpit at full would be the
    // bigger vection source, on the view with no frame to anchor it.
    const cockpitTop = anniversary.render.flatFov.addBySpeed.reduce((m, [, y]) => Math.max(m, y), 0)
    const top = BLOCK.fovAddBySpeed.reduce((m, [, y]) => Math.max(m, y), 0)
    expect(top).toBeGreaterThan(0)
    expect(top).toBeLessThanOrEqual(cockpitTop + 1)
  })
})

// ── DEV-150: the arm is 2016's arm, and the guard is how big the ship looks ──
//
// The arm length used to be 24 m, picked by eye on a monitor. DEV-128's own row
// disagreed with itself about what that looked like — a table saying the ship
// spanned "~12 % of a 102° frame" against a frames section saying "about 7 %"
// — because 12 % was an ANGLE ratio (2·atan(3.15/30) over 102.5°) where a
// screen fraction is a TAN ratio. Units, DEV-027.
//
// 2016's own number is traceable, and it is neither 24 m nor 8.89 m. The
// shipped `CamRoot_3rdPerson` on `Resources/PlayerShip_SR14_Photon.prefab`
// carries a LIVE `SmoothTransformConstraint` — `m_Enabled: 1` with the whole
// `m_Father` chain `m_IsActive: 1`, the full liveness walk — chasing
// `cam target 3rdPerson` at (0, 1.700, −12.500) in ship-root space, with
// `position_interpolation: 2` (DampLimited → `Vector3.SmoothDamp`),
// `positionSpeed: 0.066` (SmoothDamp's smoothTime, seconds) and
// `positionMaxSpeed: 695`. So 8.89 m is where `CamChanger` PARKS the rig, not
// where the camera flies: the arm is 12.5 m and the camera trails it by v·τ on
// top of that. 2016's third person was never rigid.
//
// These assertions are about GEOMETRY on purpose: what fraction of the frame
// width the ship's beam covers. That is a ratio of two measured lengths and is
// true whatever I believed about the pose — the orientation lesson. Asserting
// `armLength === 12.5` would be the constant written twice.
//
// The outside-the-port comparison (CLAUDE.md: a test that compares two of your
// own devices has tested neither) is the four third-person 2016 Steam
// screenshots, measured rather than eyeballed by
// `…/scratchpad/followups-look/measure_ship.py`: tip-to-tip 11.40 %, 12.27 %
// and 12.96 % of the frame width at HUD speeds 153 / 145 / 148 m/s
// (`EnergySystem_Ship.cs:147` is `rigidbody.velocity.magnitude`, so metres per
// second). Foreshortening and JPEG blur only SHRINK a measured width, so each
// of those is a LOWER bound on the fraction.
describe('DEV-150: the ship fills as much of the frame as it did in 2016', () => {
  /**
   * The HoverJet's beam: the SYMMETRIC extent of `hoverjet-exterior.glb`'s
   * POSITION accessor, ±3.0827093, composed through the node tree — whose
   * scale is exactly 1, so this is metres and not the centimetre trap.
   * `game/flight.ts` picks out the same axis the same way on the cockpit mesh.
   */
  const BEAM_M = 6.1654

  /**
   * The fraction of the frame's WIDTH that a `width`-metre object at `d` metres
   * covers, through a perspective camera of `vfovDeg` VERTICAL degrees at
   * `aspect`. Tangents, not angles: that is the bug this block exists to stop.
   */
  const frameFraction = (width: number, d: number, vfovDeg: number, aspect: number): number =>
    width / d / (2 * Math.tan(THREE.MathUtils.degToRad(vfovDeg) / 2) * aspect)

  /**
   * The resting lens. `render/renderer.ts` builds the scene camera at 70° and
   * `flatFov.base` is null on both presets, meaning "whatever the renderer
   * chose" (`baseFovFor`). 2016's own flat camera was 75° — `Mono_Cam/Main
   * Camera` on `Prefabs/Cameras_gameplay.prefab`, the object tagged
   * `CameraManager` that `CamChanger` reparents — so the port's frame is very
   * slightly tighter than 2016's at the same distance. The bands below are wide
   * enough that either lens gives the same verdict.
   */
  const RESTING_FOV = anniversary.render.flatFov.base ?? 70

  it('frameFraction is a tangent ratio, not an angle ratio', () => {
    // At exactly the half-width distance the object fills the frame.
    const d = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(70) / 2) * (16 / 9))
    expect(frameFraction(1, d, 70, 16 / 9)).toBeCloseTo(1, 12)
    // Doubling the distance halves the fraction — true of tangents, and false
    // of the angle ratio that put "12 %" into DEV-128's table.
    expect(frameFraction(1, 2 * d, 70, 16 / 9)).toBeCloseTo(0.5, 12)
  })

  /**
   * Fly straight and level at `speed` until the lag settles, and return how far
   * the camera ends up from the ship. This steps the port's own arm rather than
   * re-deriving it with the formula the code uses (trap 24).
   */
  const settledDistance = (block: EditionThirdPerson, speed: number, hz = 60): number => {
    const arm = createSpringArm()
    const dt = 1 / hz
    const s = ship(0, 500, 0)
    for (let i = 0; i < Math.round(8 * hz); i++) {
      s.shipPosition.z -= speed * dt
      arm.update(block, input(s, dt, NO_SURFACE))
    }
    return arm.position.distanceTo(s.shipPosition)
  }

  /**
   * 2016's OWN arm, as DEV-150 derived it: the 12.5 m target and a 6 m lag
   * cap. Anniversary shipped exactly this until DEV-357 moved the camera in at
   * Matt's ask, so the preset no longer carries it — but the derivation is
   * still the evidence for what 2016 looked like, and Classic's chase
   * (`render/classic-chase.ts`) is measured against the same target. Held
   * here as the 2016 block, not read from the preset.
   */
  const BLOCK_2016: EditionThirdPerson = { ...BLOCK, armLength: 12.5, maxLagMetres: 6 }

  it('sits where 2016 sat: 15-22 m at cruise, not 30', () => {
    // 2016, simulated with Unity's verbatim SmoothDamp against the traced
    // 12.5 m target: 20.9 m at 145 m/s and 21.3 m at 153 m/s. The port caps its
    // lag at `maxLagMetres` where 2016 effectively does not (695 × 0.066 =
    // 45.9 m), so it settles a little tighter — the one deliberate deviation,
    // and the preset note says why.
    for (const v of [145, 148, 153]) {
      const d = settledDistance(BLOCK_2016, v)
      expect(d).toBeGreaterThan(15)
      expect(d).toBeLessThan(22)
    }
  })

  it('the ship covers as much of the frame as the 2016 screenshots show', () => {
    const aspect = 16 / 9
    for (const v of [145, 153]) {
      const pct = 100 * frameFraction(BEAM_M, settledDistance(BLOCK_2016, v), RESTING_FOV, aspect)
      expect(pct).toBeGreaterThan(9)
      expect(pct).toBeLessThan(16)
    }
  })

  it('DEV-357: Anniversary sits about two thirds of the 2016 distance, and the ship is bigger', () => {
    // Matt, 2026-09-24: "i'd love to be closer", then "about two thirds".
    // Stepped through the port's own arm at the same cruise speeds, so a
    // change to the arm's maths moves this too (trap 24), and bounded against
    // the 2016 block rather than against a number of metres.
    const aspect = 16 / 9
    for (const v of [145, 153]) {
      const now = settledDistance(BLOCK, v)
      const then = settledDistance(BLOCK_2016, v)
      expect(now / then).toBeGreaterThan(0.5)
      expect(now / then).toBeLessThan(0.75)
      const pct = 100 * frameFraction(BEAM_M, now, RESTING_FOV, aspect)
      expect(pct, 'the ship is bigger than any 2016 screenshot').toBeGreaterThan(16)
      expect(pct, 'and not so big it hides the course').toBeLessThan(30)
    }
  })

  it('rejects the two poses that are NOT 2016: the old guess and the parked pose', () => {
    // A band that only admits the value it was written for has tested nothing.
    // These are the two readings DEV-150 was sent to settle, and the band above
    // has to separate them — "what case makes my rule and the alternative
    // disagree?"
    const aspect = 16 / 9
    const at = (d: number) => 100 * frameFraction(BEAM_M, d, RESTING_FOV, aspect)
    expect(at(30)).toBeLessThan(9) // the old 24 m arm plus 6 m of lag
    expect(at(8.89)).toBeGreaterThan(16) // `CamRoot_3rdPerson`'s parked pose
  })

  it('is frame-rate independent: 60 Hz and 144 Hz settle in the same place', () => {
    const a = settledDistance(BLOCK, 150, 60)
    const b = settledDistance(BLOCK, 150, 144)
    expect(Math.abs(a - b)).toBeLessThan(0.05)
  })
})

describe('the arm holds its own pole (DEV-292)', () => {
  it('changes NOTHING for the free look, which is already clamped tighter', () => {
    // The premise that makes this guard safe to add to a shipped camera, and
    // it is an argument rather than a run: `createFreeLook` clamps to
    // `FREE_LOOK_PITCH_LIMIT`, and every value it can produce is inside
    // `ARM_PITCH_LIMIT`, so the clamp is the identity on the only caller that
    // existed before the phone.
    expect(FREE_LOOK_PITCH_LIMIT).toBeLessThan(ARM_PITCH_LIMIT)
    for (const p of [0, 0.5, -0.5, FREE_LOOK_PITCH_LIMIT, -FREE_LOOK_PITCH_LIMIT]) {
      expect(clampArmPitch(p), `free look ${p}`).toBe(p)
    }
  })

  it('holds a phone-driven pitch off the vertical', () => {
    // `quatPitch` is an `asin`, so a phone held flat reaches ±90° exactly.
    // That is the degenerate case: an arm standing straight up has no heading
    // left, and its roll becomes whatever the lagged follow left behind.
    expect(clampArmPitch(Math.PI / 2)).toBe(ARM_PITCH_LIMIT)
    expect(clampArmPitch(-Math.PI / 2)).toBe(-ARM_PITCH_LIMIT)
    expect(ARM_PITCH_LIMIT, 'strictly inside vertical').toBeLessThan(Math.PI / 2)
  })

  it('keeps a horizontal STAND-OFF at full pitch, which is the whole point', () => {
    // The geometry the clamp exists for, rather than the number it is made of
    // — the orientation lesson's *test the geometry, not the rotation*.
    //
    // At exactly ±90° the arm stands on its pole: horizontal offset zero,
    // camera directly over (or under) the ship, and no heading left for the
    // roll to be measured from. Clamped, it keeps a real horizontal stand-off,
    // and that is a distance anybody can check without believing anything
    // about euler order or sign.
    const arm = createSpringArm()
    const s = ship(0, 500, 0)
    arm.update(BLOCK, input(s, 1 / 60, NO_SURFACE, { lookYaw: 0, lookPitch: Math.PI / 2 }))
    const dx = arm.position.x - s.shipPosition.x
    const dz = arm.position.z - s.shipPosition.z
    const horizontal = Math.hypot(dx, dz)
    expect(horizontal, `stand-off ${horizontal.toFixed(2)} m`).toBeGreaterThan(1)
    // And the look is not merely being thrown away: the camera really does
    // travel most of the arm's length off level. Without this half the test
    // would pass on a build that ignored `lookPitch` entirely.
    const vertical = Math.abs(arm.position.y - s.shipPosition.y)
    expect(vertical, `${vertical.toFixed(2)} m off level`).toBeGreaterThan(BLOCK.armLength * 0.7)
  })

  it('positive pitch DROPS the lens, which is the free look’s own convention', () => {
    // Written down because the first draft of the test above assumed the
    // opposite and was wrong — the arm was right.
    //
    // `lookPitch` is `look.ts`'s pitch, where positive means LOOK UP. On an
    // orbit that swings the lens DOWN and aims it back up at the ship, which
    // is how every third-person camera has ever worked and what
    // `spring-arm.ts` says at the multiply: the arm's direction is rotated
    // about +x, and (0, 0, 1) about +x by φ gives y = −sin φ.
    //
    // It matters for DEV-292 because it is what makes the phone read as a
    // window: tilt the phone DOWN and the lens rises and looks down, so you
    // see the ground. A sign flip here would have the world move the wrong way
    // in your hand, and every magnitude assertion in this file would still pass.
    const s = ship(0, 500, 0)
    const at = (lookPitch: number) => {
      const arm = createSpringArm()
      arm.update(BLOCK, input(s, 1 / 60, NO_SURFACE, { lookYaw: 0, lookPitch }))
      return arm.position.y - s.shipPosition.y
    }
    expect(at(0.6), 'look up -> lens drops').toBeLessThan(at(0))
    expect(at(-0.6), 'look down -> lens rises').toBeGreaterThan(at(0))
  })

  it('yaw walks the lens round the ship, and a phone may go all the way', () => {
    // The yaw is deliberately NOT clamped for the phone — turning round and
    // having the camera come with you is the good part of the feature. So the
    // arm has to be sane at a yaw the free look could never reach: its own
    // limit is 2 rad, and this is past π.
    const s = ship(0, 500, 0)
    const bearingAt = (lookYaw: number) => {
      const arm = createSpringArm()
      arm.update(BLOCK, input(s, 1 / 60, NO_SURFACE, { lookYaw, lookPitch: 0 }))
      return Math.atan2(arm.position.x - s.shipPosition.x, arm.position.z - s.shipPosition.z)
    }
    // Half a turn puts the lens on the opposite side — in FRONT of the ship.
    const astern = bearingAt(0)
    const ahead = bearingAt(Math.PI)
    let delta = Math.abs(ahead - astern)
    if (delta > Math.PI) delta = 2 * Math.PI - delta
    expect(
      delta,
      `half a turn moved the lens by ${((delta * 180) / Math.PI).toFixed(1)}°`,
    ).toBeCloseTo(Math.PI, 2)
    // And the stand-off is unchanged: a yaw orbits, it does not push away.
    const r = (y: number) => {
      const arm = createSpringArm()
      arm.update(BLOCK, input(s, 1 / 60, NO_SURFACE, { lookYaw: y, lookPitch: 0 }))
      return Math.hypot(arm.position.x - s.shipPosition.x, arm.position.z - s.shipPosition.z)
    }
    expect(r(Math.PI)).toBeCloseTo(r(0), 6)
  })
})
