// tests/unit/title-flypast-direction.test.ts — the jets fly TOWARDS you.
//
// Matt, from the headset, 2026-09-17: *"titlescreen jet is flying it's path in
// reverse (should be flying towards the camera, not away from it)"*. DEV-202.
//
// Extended by DEV-215, which did not change the direction and could not: all
// four `SplineWalker`s in `main_menu.unity` carry `Forward: 0`, so descending is
// right on every spline in the scene. What DEV-215 changed is WHICH splines —
// the port had been flying a nine-point curve nobody walks — and HOW MANY ships,
// which is now two. Every assertion below therefore runs over BOTH lanes, and
// the numbers are per lane because the two paths are not alike: 1,703 m against
// 3,574 m.
//
// ── Why this file exists beside `title-flypast.test.ts` ───────────────────
//
// `title-flypast.test.ts` guards the AIM and `title-placement.test.ts` guards
// the PLACE — range, angular size, and how much of the lap is on screen. Every
// one of those assertions was green while this bug shipped, and all of them
// were correct, because **not one of them asks which way the ship is going**.
// That is DEV-044's shape restated: *"every e2e assertion on that screen was
// about positions and counts, all correct."* A range is the same number whether
// the ship is arriving or leaving.
//
// So the claim here is a SIGN, and it is the one nobody had written down: the
// component of the ship's velocity along the line to the eye. Positive is
// closing. It is a dot product between two things the code computes for its own
// reasons, so it is true independently of what anyone believed about
// quaternions, handedness or the order of control points — CLAUDE.md's
// orientation lesson, *"test the geometry, not the rotation."*
//
// And it is worth saying what that bought when the premise underneath it turned
// out to be wrong. DEV-155 measured the wrong spline; this file's assertions
// were all still true, all still meaningful, and all still passed on the right
// one after a re-measure, because none of them names a control point. A test
// written about the geometry survives being wrong about the object.
//
// ── The two causes this separates, because they have opposite fixes ───────
//
// A jet can look like it is going backwards two ways, and from a seat they are
// the same complaint:
//
//   wrong TRAVEL   velocity points away from the eye; the nose agrees with the
//                  velocity. Flying away, correctly posed.
//   wrong AIM      velocity points at the eye (right) and the nose points the
//                  other way, so it flies tail-first.
//
// Both are measured below, every sample, and they are reported separately. What
// was live was the travel; the aim was right the whole time and this file is
// what says so. Fixing the travel without the heading point would have turned
// the first into the second, which is why `flypastFractions` returns both
// fractions from one call and why that call is exercised here rather than
// re-derived — CLAUDE.md trap 24.
//
// No height map and no assets: sixteen measured points, one measured camera, so
// there is nothing to skip on.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TERRAIN } from '@/generated/constants.generated'
import {
  aimShip,
  FLYPAST_ROLL,
  flypastCurve,
  flypastFractions,
  levelGaze,
  TITLE_2016,
  terrainMeshToWorld,
} from '@/render/title'

const DEG = 180 / Math.PI

/**
 * `main_menu.unity`'s own world coordinates for the two walked splines and the
 * camera — the UNITY frame, through `tools/prototype/unity_scene_to_json.js`
 * composing the parent chain, which is a second route that never met
 * `terrainMeshToWorld`. This file's whole argument is that the two frames must
 * agree about closing speed, so both sides have to exist independently.
 *
 * Control points in CURVY'S order, which is by NAME (`CurvySpline.cs:1421`) and
 * not by sibling index — `path_ai`'s `CP009` sits at `m_RootOrder: 2`. Both
 * lists are the children of the spline's own GameObject, composed with its
 * transform: `path_ai` hangs at (0, 6.426321, 1.658587) under `npc_stuff` and
 * `path_ai_02` at (0, 8.280874, -8.449232), which is why the round numbers in
 * the scene are not the round numbers here.
 */
const CP_2016: readonly (readonly (readonly [number, number, number])[])[] = [
  // path_ai_02 — walked by `npc_aiShip`, the ship with the look-at constraint.
  [
    [-77.2, 96.280874, -11.049232],
    [-157.2, 1.650874, 120.550768],
    [-163.7, 73.980874, 261.550768],
    [-75.8, 178.880874, 451.650768],
    [107.16068, 121.280874, 486.550768],
    [214, 366.280874, 143.508918],
  ],
  // path_ai — walked by `npc_aiShip_02`, the one the stripped prefab hid.
  [
    [49, 405.426321, -233.341413],
    [-119.9, 65.626321, -1.241413],
    [-167.8, 9.326321, 170.358587],
    [-242, 93.426321, 279.658587],
    [-243, 341.426321, 412.658587],
    [22.94049, 36.822421, 356.071687],
    [278, 69.426321, 450.658587],
    [574, 8.770765, 399.658587],
    [658, 539.426321, 132.658587],
    [469, 587.426321, -146.341413],
  ],
]
/** `TitleScene/Cameras`, same measurement, same frame. */
const CAMERA_WORLD_2016 = [-166.1991, 3.5874, 95.3571] as const

/** The title valley's group, built exactly as `boot/app.ts` has it. */
const TITLE_VALLEY_OFFSET = [30_000, 0, 0] as const
const titleGroup = (): THREE.Group => {
  const t = TERRAIN.alpine.terrains.forest.transform
  const g = new THREE.Group()
  g.position.set(
    TITLE_VALLEY_OFFSET[0] + t.position[0] + t.envRoot[0],
    TITLE_VALLEY_OFFSET[1] + t.position[1] + t.envRoot[1],
    TITLE_VALLEY_OFFSET[2] - (t.position[2] + t.envRoot[2]),
  )
  g.quaternion.fromArray([...TITLE_2016.terrainQuaternion])
  return g
}

/** `renderer.ts`'s flat FOV, and 16:9 — the frame is wider than it is tall. */
const HALF_FOV_DEG = 35
const HALF_FOV_H_DEG = Math.atan(Math.tan(35 / DEG) * (16 / 9)) * DEG

/** 64 samples of one lap, through the shipped paths and the shipped fractions. */
const SAMPLES = 64

/** The two lanes, by index into `TITLE_2016.flypaths`, for `it.each`. */
const LANES = TITLE_2016.flypaths.map((lane, index) => ({ index, spline: lane.spline }))

interface Sample {
  /** Seconds since the screen came up. */
  readonly second: number
  /** Metres from the eye. */
  readonly range: number
  /** `velocity · (eye − position)`, both unit. Positive is closing. */
  readonly closing: number
  /**
   * `nose · velocity` after `aimShip`. 1 is nose-first, −1 is tail-first.
   *
   * The two sides are independent: the velocity is motion over time and the
   * nose comes from the heading point. See `flyTheLap`.
   */
  readonly noseDotVelocity: number
  /** Inside the flat frame, in front of the eye. */
  readonly inFrame: boolean
  /** In front of the eye at all — false is literally behind your head. */
  readonly ahead: boolean
  /** Signed turn rate about world up. Positive is a left turn. */
  readonly turn: number
  /** World y of the wing on the INSIDE of the turn. Negative is banking in. */
  readonly insideWingY: number
}

/**
 * Fly one lane's lap, through the same three calls `title.ts`'s `update` makes.
 *
 * `flypastCurve` and `flypastFractions` are the shipped ones on purpose: the
 * direction, the heading lead and the roll all live in the module, so a test
 * that re-wrote any of them would agree with itself and prove nothing. The
 * lane's `initialF` is the shipped one too — it is the ship's own walker's, and
 * the two ships do not share it (0.43 and 0.78).
 *
 * ── The velocity is WHERE IT WENT, never where it is looking ──────────────
 *
 * This matters more than it looks. The first cut of this file took `velocity`
 * as `headingPoint − position`, which makes `nose · velocity` a TAUTOLOGY: both
 * sides come out of `flypastFractions().ahead`, so the tail-first assertion was
 * comparing the code to itself and passed on a mutant that aimed the ship
 * backwards. CLAUDE.md: *"a test that compares two of your own devices has not
 * tested either of them."* It was caught by deliberately building that mutant.
 *
 * So the velocity here is a central difference of POSITION over TIME — where
 * the ship actually gets to — and only the nose comes from the heading point.
 * The two are then independent and their dot product is a real measurement.
 */
const flyTheLap = (laneIndex: number): readonly Sample[] => {
  const lane = TITLE_2016.flypaths[laneIndex] as (typeof TITLE_2016.flypaths)[number]
  const group = titleGroup()
  const world = (p: readonly number[]) => terrainMeshToWorld(p, group)
  const curve = flypastCurve(lane.mesh.map((p) => world(p as readonly number[])))
  const eye = world(TITLE_2016.cameraMesh)
  // The rig's pose, as `boot/app.ts` composes it; its inverse takes a world
  // offset into camera space, where the camera looks along its own −z.
  const facing = -(TITLE_2016.cameraYaw / DEG)
  const forward = new THREE.Vector3(-Math.sin(facing), 0, -Math.cos(facing))
  const toCamera = levelGaze(forward).clone().invert()

  const lap = TITLE_2016.flypathLapSeconds
  /** Where the ship IS at `seconds`, through the shipped fraction. */
  const posAt = (seconds: number) =>
    curve.getPointAt(flypastFractions(seconds, lap, lane.initialF).at, new THREE.Vector3())
  /** Which way it is actually MOVING: central difference over time. */
  const step = lap / 2048
  const velAt = (seconds: number) =>
    posAt(seconds + step)
      .sub(posAt(seconds - step))
      .normalize()

  const out: Sample[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const second = (i / SAMPLES) * lap
    const f = flypastFractions(second, lap, lane.initialF)
    const p = curve.getPointAt(f.at, new THREE.Vector3())
    const next = curve.getPointAt(f.ahead, new THREE.Vector3())
    const velocity = velAt(second)
    // A whole sample earlier, for the turn rate.
    const velocityBefore = velAt(second - lap / SAMPLES)

    const ship = new THREE.Object3D()
    ship.position.copy(p)
    aimShip(ship, next, FLYPAST_ROLL)
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.quaternion)
    // Nose along −z and up along +y put the right wing on local +x.
    const rightWing = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.quaternion)
    // Rotation about world +y is counter-clockwise seen from above, so a
    // positive y here is a LEFT turn and the inside wing is the left one.
    const turn = new THREE.Vector3().crossVectors(velocityBefore, velocity).y

    const toEye = eye.clone().sub(p)
    const cam = p.clone().sub(eye).applyQuaternion(toCamera)
    const az = Math.atan2(cam.x, -cam.z) * DEG
    const el = Math.atan2(cam.y, Math.hypot(cam.x, cam.z)) * DEG

    out.push({
      second,
      range: toEye.length(),
      closing: velocity.dot(toEye.clone().normalize()),
      noseDotVelocity: nose.dot(velocity),
      ahead: cam.z < 0,
      inFrame: cam.z < 0 && Math.abs(az) < HALF_FOV_H_DEG && Math.abs(el) < HALF_FOV_DEG,
      turn,
      insideWingY: turn > 0 ? -rightWing.y : rightWing.y,
    })
  }
  return out
}

describe('the title flypast comes TOWARDS you', () => {
  it.each(LANES)('opens closing, and holds it for five seconds — $spline', ({ index }) => {
    // The assertion that was missing. Before DEV-202 every sample of the opening
    // was NEGATIVE: the screen came up with the jet receding for 4.8 s, in frame
    // the whole time.
    //
    // MEASURED on the two lanes that ship, all 14 opening samples each:
    //
    //   path_ai_02   474.4 m -> 204.8 m, closing 0.384 rising to 0.976
    //   path_ai      993.5 m -> 766.6 m, closing 0.085 rising to 0.687
    //
    // Both close from the first sample. What differs is the FRAME, and that is
    // asserted separately below, because it is a different claim about a
    // different thing and lumping them cost this file its second lane.
    const lap = flyTheLap(index)
    const opening = lap.filter((s) => s.second <= 5)
    expect(opening.length).toBeGreaterThan(10)
    for (const s of opening) expect(s.closing).toBeGreaterThan(0)
    // And it is actually getting nearer, not merely pointed the right way:
    // the range falls across the opening.
    const first = opening[0] as Sample
    const last = opening[opening.length - 1] as Sample
    expect(last.range).toBeLessThan(first.range)
  })

  it('has the near ship in frame from the very first sample', () => {
    // Lane 0 is `npc_aiShip` — 2016's primary, the one with the look-at
    // constraint, and the one a single-racer edition gets. It is in frame at
    // t = 0 and stays there through the whole opening: 14 of 14.
    const opening = flyTheLap(0).filter((s) => s.second <= 5)
    for (const s of opening) expect(s.inFrame).toBe(true)
  })

  it('brings the far ship in off the right edge, and keeps it', () => {
    // Lane 1 is NOT in frame at t = 0 and that is 2016's own arithmetic rather
    // than a defect: `npc_aiShip_02`'s `InitialF: 0.78` starts it 993 m out at
    // azimuth 57.0 deg, and the half-frame is 51.24 deg — 5.8 deg outside the
    // right edge. It slides in at t = 1.12 s and is in frame for every sample
    // after that. Asserted as "the first three and then never again" rather than
    // as a count, so a re-measure that moves the entry moves this test's failure
    // into the open instead of quietly re-tuning a threshold.
    const opening = flyTheLap(1).filter((s) => s.second <= 5)
    const firstIn = opening.findIndex((s) => s.inFrame)
    expect(firstIn).toBeGreaterThan(0)
    expect(firstIn).toBeLessThan(5)
    for (const s of opening.slice(firstIn)) expect(s.inFrame).toBe(true)
  })

  it.each(LANES)(
    'shows the arrival, not the departure — most of what is in frame closes — $spline',
    ({ index }) => {
      // The whole-lap version, and the number that moved. On the spline the port
      // used to fly, 42 of 64 samples were in frame and only **13** of them were
      // closing before DEV-202; 29 after. On the two that ship now:
      //
      //   path_ai_02   35 of 64 in frame, **29** closing
      //   path_ai      28 of 64 in frame, **25** closing
      //
      // A majority is the claim; the counts are in DEV-215.
      const lap = flyTheLap(index)
      const inFrame = lap.filter((s) => s.inFrame)
      expect(inFrame.length).toBeGreaterThan(SAMPLES / 3)
      const closing = inFrame.filter((s) => s.closing > 0).length
      expect(closing).toBeGreaterThan(inFrame.length / 2)
    },
  )

  it.each(LANES)('does the close pass in FRONT of your head — $spline', ({ index }) => {
    // The sharpest statement of the old bug, and the one a viewer feels: the
    // only real approach on the lap used to happen entirely behind the camera,
    // seven consecutive samples with the ship out of shot. You saw it leave and
    // never saw it arrive.
    //
    // So: take the run of samples that are both close and closing hard, and
    // require that they are in front of the eye. Measured, every one is —
    // 9 of 9 on `path_ai_02` and 5 of 5 on `path_ai`.
    const lap = flyTheLap(index)
    const runIn = lap.filter((s) => s.closing > 0.5 && s.range < 250)
    expect(runIn.length).toBeGreaterThan(3)
    for (const s of runIn) expect(s.ahead).toBe(true)
  })

  it.each(LANES)(
    'never flies tail-first — the lead reverses WITH travel — $spline',
    ({ index }) => {
      // The guard on the half-fix. Reverse the direction of travel and leave the
      // heading point where it was and the ship flies the right way round the
      // path facing backwards, which looks worse than the bug and reads the same
      // from a seat. `flypastFractions` returns both fractions from one call so
      // they cannot drift; this is what fails if anyone splits them.
      //
      // Note what is NOT asserted: a quaternion. The angle between the nose and
      // the direction of travel is a number whatever anyone believes about the
      // z-mirror, and it was small before DEV-202 too — the aim was never the
      // defect, and this file is the evidence for that.
      //
      // Not zero either, and it should not be. The heading point is 1 % of a lap
      // ahead, so on a curve the chord to it leans off the tangent and the nose
      // cuts the corner by that much — and the cost scales with the path, because
      // 1 % of 3,574 m is twice 1 % of 1,703 m. MEASURED over the lap:
      //
      //   path_ai_02   median 1.48 deg, p90 5.43, max  9.84
      //   path_ai      median 2.51 deg, p90 6.74, max 53.99
      //
      // The 53.99 is one sample at the tightest corner of the long path, and it
      // is **off screen** — t = 11.16 s, 466 m out, behind the right edge. The
      // worst either lane ever does WHILE IN FRAME is 12.69 deg, which is the
      // number that decides whether a lead in metres would be worth the
      // mechanism, and it says no. So the ceiling below is asserted twice: a
      // loose one on the whole lap, and the tight one on what a player can see.
      const lap = flyTheLap(index)
      const angleOf = (s: Sample) => Math.acos(Math.min(1, s.noseDotVelocity)) * DEG
      const angles = lap.map(angleOf).sort((a, b) => a - b)
      expect(angles[angles.length - 1] as number).toBeLessThan(60)
      expect(angles[Math.floor(angles.length / 2)] as number).toBeLessThan(4)
      // A tail-first ship is 180 deg from travel, so nothing here is confusable
      // with one — but what a viewer would actually notice is a nose that is not
      // pointing where the ship is going, ON SCREEN.
      const seen = lap.filter((s) => s.inFrame).map(angleOf)
      expect(seen.length).toBeGreaterThan(SAMPLES / 4)
      expect(Math.max(...seen)).toBeLessThan(20)
    },
  )

  it.each(LANES)('banks INTO its turns — the sign that reversed too — $spline', ({ index }) => {
    // A constant roll on a path that turns both ways is into the turn most of
    // the time and never all of it — that is the scripted-bank simplification,
    // not a bug. Measured on the shipped lanes: the inside wing is below the
    // hull on **63 of 64** samples on `path_ai_02` and **53 of 64** on
    // `path_ai`, and it is the SAME samples with the direction and the roll
    // flipped together. Flip only the direction and the ship leans out of every
    // turn for a whole lap — 13 of 62 on the old spline, which is where this
    // assertion came from.
    const lap = flyTheLap(index)
    const turning = lap.filter((s) => Math.abs(s.turn) > 1e-3)
    expect(turning.length).toBeGreaterThan(SAMPLES / 2)
    const into = turning.filter((s) => s.insideWingY < 0).length
    expect(into).toBeGreaterThan(turning.length * 0.6)
  })

  it.each(LANES)('starts where its OWN InitialF puts it — $spline', ({ index }) => {
    // Reversing the ARRAY would have moved the start, and by a DIFFERENT amount
    // per path: `getPointAt(0.43)` of a reversed `path_ai_02` is 181.8 m away,
    // and `getPointAt(0.78)` of a reversed `path_ai` is 852.0 m away. Each
    // constant would have had to be re-derived to go on saying what it was
    // measured to say. Negating the time term does not move either, and this is
    // the assertion that catches anyone who "simplifies" it back to a reorder.
    const lane = TITLE_2016.flypaths[index] as (typeof TITLE_2016.flypaths)[number]
    const lap = TITLE_2016.flypathLapSeconds
    expect(flypastFractions(0, lap, lane.initialF).at).toBeCloseTo(lane.initialF, 12)
    // A whole lap returns to the start, in either direction.
    expect(flypastFractions(lap, lap, lane.initialF).at).toBeCloseTo(lane.initialF, 12)
    // And the heading point is ahead in the direction TIME moves, not behind.
    // Asserted as agreement between two displacements rather than as a sign, so
    // it stays true if the direction is ever revisited: whichever way the ship
    // goes, the point it looks at is on the side a later position is on.
    const step = (from: number, to: number) => ((to - from + 1.5) % 1) - 0.5
    const now = flypastFractions(0, lap, lane.initialF)
    const later = flypastFractions(lap / 256, lap, lane.initialF)
    const lead = step(now.at, now.ahead)
    const advance = step(now.at, later.at)
    expect(Math.sign(lead)).toBe(Math.sign(advance))
    // And it really is a LEAD — further along than one 256th of a lap, so the
    // heading cannot collapse to "where the ship already is".
    expect(Math.abs(lead)).toBeGreaterThan(Math.abs(advance))
  })

  it('gives the two ships DIFFERENT starts, which is what makes them two ships', () => {
    // The spread that used to exist — `index / count` around one shared path —
    // is gone, because the ships are on separate splines and each carries its
    // own `SplineWalker.InitialF`. If anyone re-introduces a spread, or copies
    // one lane's `initialF` onto the other, this is what says so.
    const [a, b] = TITLE_2016.flypaths
    expect(a?.initialF).not.toBe(b?.initialF)
    const lap = TITLE_2016.flypathLapSeconds
    expect(flypastFractions(0, lap, a?.initialF ?? 0).at).not.toBeCloseTo(
      flypastFractions(0, lap, b?.initialF ?? 0).at,
      6,
    )
  })
})

describe('the frame the ships are measured in cannot be what is wrong', () => {
  it.each(LANES)(
    "agrees with 2016's own Unity frame on every range and closing speed — $spline",
    ({ index }) => {
      // `terrainMeshToWorld` is a reflection composed with a rigid placement, and
      // a reflection preserves DISTANCE. So the range from camera to ship over the
      // lap is the same number in the port's world frame and in `main_menu.unity`'s
      // own — and so is the closing speed, which is a rate of change of that
      // range. No mirror bug, no placement bug and no re-measured quaternion can
      // turn an arrival into a departure.
      //
      // That is why DEV-202 is a SIGN in the traversal and not a frame error, and
      // this is the assertion that says so rather than the prose. The 2016 side
      // uses the Unity-space numbers directly: no `terrainMeshToWorld`, no group,
      // no quaternion — two routes that never met.
      //
      // It is also the check that would have caught DEV-215's own hazard, had
      // the re-measure gone wrong: `CP_2016` above is the scene's raw world
      // coordinates and `TITLE_2016.flypaths` is the mesh-frame conversion of
      // them, so a lane converted with the wrong offset or the wrong rotation
      // stops agreeing here, sample for sample.
      const lane = flyTheLap(index)
      const curve = flypastCurve(
        (CP_2016[index] as readonly (readonly [number, number, number])[]).map(
          (p) => new THREE.Vector3(p[0], p[1], p[2]),
        ),
      )
      const eye = new THREE.Vector3(...CAMERA_WORLD_2016)
      const seconds = TITLE_2016.flypathLapSeconds
      const startF = (TITLE_2016.flypaths[index] as (typeof TITLE_2016.flypaths)[number]).initialF

      const posAt = (s: number) =>
        curve.getPointAt(flypastFractions(s, seconds, startF).at, new THREE.Vector3())
      const step = seconds / 2048
      for (let i = 0; i < SAMPLES; i++) {
        const second = (i / SAMPLES) * seconds
        const p = posAt(second)
        const toEye = eye.clone().sub(p)
        // Same definition as `flyTheLap`: motion over time, not the heading point.
        const closing = posAt(second + step)
          .sub(posAt(second - step))
          .normalize()
          .dot(toEye.clone().normalize())
        const port = lane[i] as Sample
        // Centimetres over a 1 km range, and ~1e-6 on a unit dot product. The
        // flattener wrote the quaternion to 6 dp and the camera is 3.8 km from the
        // terrain's origin, so one ulp of that rounding is millimetres here — the
        // oracle's own precision rather than a disagreement (see `cameraMesh`).
        expect(port.range).toBeCloseTo(toEye.length(), 2)
        expect(port.closing).toBeCloseTo(closing, 5)
      }
    },
  )
})
