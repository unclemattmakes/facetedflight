// tests/unit/cockpit-shake.test.ts — the buffet, and the one thing it must
// never touch.
//
// DEV-083, ANNIVERSARY.md §2.4/S3. There are two different claims here and they
// need different kinds of evidence:
//
//  1. **The signal behaves.** Zero below the threshold, monotone with speed,
//     stepped at the boost floors the sheet carries, bounded by the preset's
//     ceilings, linear in the comfort slider, deterministic and smooth in time.
//     Pure functions, so pure assertions.
//
//  2. **The COCKPIT moves and the CAMERA does not** — the Squadrons rule, and
//     the whole reason this feature is allowed to exist in a headset at all.
//     That one cannot be asserted by measuring the shake, because a shake of any
//     size satisfies "the camera did not move" if you only ever look at the
//     camera. It is asserted two ways instead: structurally, against the SHIPPED
//     source of `game/flight.ts` and `game/jumpseat-flight.ts`; and
//     geometrically, by building the real hierarchy and showing the case where
//     the two explanations DISAGREE — a marker that hangs off `art_pivot` moves,
//     and the eye, which does not, stays exactly put.
//
// What none of this can say is whether it feels right, or whether it makes
// anybody ill. `docs/vr-testing.md` is explicit that comfort is untestable by
// construction; ANNIVERSARY.md §2.6 puts the three external testers on the
// Anniversary preset separately from Classic. This suite protects the numbers
// so that the headset session is spent on the question only a headset can
// answer.

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createShakeLookdev } from '@/boot/lookdev-shake'
import { forChannel } from '@/content/build-channel'
import {
  applyVrOverrides,
  type Edition,
  type EditionCockpitShake,
  type EditionShakeThrottle,
  validateEdition,
} from '@/content/edition-schema'
import { onPivot, poseArtPivot } from '@/game/art-pivot'
import {
  BOOST_STAGE_SPEEDS,
  boostStage,
  boostWeight,
  cockpitShakeGain,
  createShakeEngine,
  createShakeSample,
  readShakeEngine,
  type ShakeEngine,
  sampleCockpitShake,
  shakeSpeedRamp,
  throttleShakeGain,
  topSpeedWeight,
} from '@/game/cockpit-shake'
import { ART_PIVOT, ART_POSITION, ART_SCALE, EYE, SHIP_MODEL_YAW } from '@/game/flight'
import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import {
  createHoverJet,
  cruiseSpeed,
  type HoverJetInput,
  noInput,
  stepHoverJet,
} from '@/sim/hoverjet'
import schemaJson from '../../content/editions/_schema.json'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { createValidator, type SchemaNode } from './helpers/json-schema'

const ANNIVERSARY = anniversaryJson.cockpit.shake as EditionCockpitShake
const CLASSIC = classicJson.cockpit.shake as EditionCockpitShake

const SHIP = HOVERJET.ship

/** The sample as five numbers, for a bounds sweep that does not care which is which. */
const channels = (s: ReturnType<typeof createShakeSample>) => [s.x, s.y, s.z, s.roll, s.pitch]

/**
 * Source with the prose taken out.
 *
 * Every text guard in this file scans CODE. Scanning the raw file instead finds
 * `Math.random` in the sentence that says there is no `Math.random`, and finds
 * `rig` inside the word "origin" — both of which happened, both on the first
 * run, and both would have been read as a real failure by anyone who did not
 * write the comment. This repo's own lesson in the other direction
 * (`route-clearance`): a guard that matches the wrong thing is a guard that
 * rots, whichever way it fails.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const sample = (
  shake: EditionCockpitShake,
  scale: number,
  time: number,
  speed: number,
  active = true,
) => sampleCockpitShake(createShakeSample(), shake, scale, time, speed, active)

// ── 1. the ladder comes off the sheet ─────────────────────────────────────

describe('the boost stages are 2016 s, imported rather than retyped', () => {
  it('is the shipped prefab s three floors, in order', () => {
    // DEV-069: when the sheet has a key for the thing you are implementing,
    // import the key and assert against it. `hoverjet.input.controlScheme` said
    // "a" for four sessions while the pad flew something else, because nothing
    // ever compared the two.
    expect(BOOST_STAGE_SPEEDS).toEqual([
      SHIP.minBoostEffectsSpeed,
      SHIP.minBoostEffect_stage2_speed,
      SHIP.minBoostEffect_stage3_speed,
    ])
    expect([...BOOST_STAGE_SPEEDS].sort((a, b) => a - b)).toEqual([...BOOST_STAGE_SPEEDS])
  })

  it('steps exactly where the boost plume steps', () => {
    // `game/particle-fx.ts` derives the same ladder for the particles, and the
    // two have to agree or the cockpit buffets at one speed while the plume
    // lights at another and they read as unrelated effects.
    expect(boostStage(0)).toBe(0)
    expect(boostStage(SHIP.minBoostEffectsSpeed - 0.001)).toBe(0)
    expect(boostStage(SHIP.minBoostEffectsSpeed)).toBe(1)
    expect(boostStage(SHIP.minBoostEffect_stage2_speed - 0.001)).toBe(1)
    expect(boostStage(SHIP.minBoostEffect_stage2_speed)).toBe(2)
    expect(boostStage(SHIP.minBoostEffect_stage3_speed - 0.001)).toBe(2)
    expect(boostStage(SHIP.minBoostEffect_stage3_speed)).toBe(3)
    // Top speed off the same prefab; there is no stage 4.
    expect(boostStage(SHIP.maxSpeed)).toBe(3)
  })
})

// ── 2. the preset s own numbers ───────────────────────────────────────────

describe('the Anniversary preset is authored inside its own limits', () => {
  it('does not start buffeting before the game says you are moving', () => {
    // `minEffectsSpeed` is where 2016 itself starts drawing air off the hull.
    // A buffet below that would be the cockpit shaking in still air.
    expect(ANNIVERSARY.startSpeed).toBeGreaterThanOrEqual(SHIP.minEffectsSpeed)
  })

  it('keeps every frequency to at least four samples a cycle at 72 Hz', () => {
    // A Quest runs at 72. A sine sampled three times a cycle is a strobe, not
    // air, and it is the failure mode nobody sees on a 144 Hz monitor.
    for (const f of ANNIVERSARY.frequency) expect(f).toBeLessThan(72 / 4)
    expect(ANNIVERSARY.frequency.length).toBeGreaterThanOrEqual(2)
  })

  it('never asks for more than a centimetre and half a degree', () => {
    // The ceilings in the brief: a few millimetres and a fraction of a degree
    // at cruise, about a centimetre and ~0.5 degrees at stage 3. It is a
    // buffet, not an earthquake — and in VR "too much" is a comfort failure,
    // not a taste one.
    const worst = Math.max(...ANNIVERSARY.stageGain)
    expect(ANNIVERSARY.amplitude * worst).toBeLessThanOrEqual(0.012)
    expect(THREE.MathUtils.radToDeg(ANNIVERSARY.angle * worst)).toBeLessThanOrEqual(0.5)
  })

  it('is a few millimetres at a 150 m/s cruise', () => {
    const gain = cockpitShakeGain(ANNIVERSARY, 1, 150)
    expect(gain.translate).toBeGreaterThan(0.001)
    expect(gain.translate).toBeLessThan(0.005)
    expect(THREE.MathUtils.radToDeg(gain.rotate)).toBeLessThan(0.2)
  })

  it('never moves on Classic, at any speed, at any time', () => {
    // The invariant the whole split rests on. Classic is off AND zero — see the
    // note in `classic.json` — so this stays true even if someone flips the flag
    // by hand to see what happens.
    for (const speed of [0, 25, 120, 240, 350, SHIP.maxSpeed]) {
      for (const t of [0, 0.37, 11.5, 600]) {
        expect(channels(sample(CLASSIC, 1, t, speed))).toEqual([0, 0, 0, 0, 0])
      }
    }
  })
})

// ── 3. the signal ─────────────────────────────────────────────────────────

describe('the ramp is a ramp', () => {
  it('is zero at and below the start speed, with zero slope', () => {
    expect(shakeSpeedRamp(ANNIVERSARY, 0)).toBe(0)
    expect(shakeSpeedRamp(ANNIVERSARY, ANNIVERSARY.startSpeed)).toBe(0)
    // The square is there so that CROSSING the threshold fades in instead of
    // popping on. One metre per second past it must still be nothing much.
    expect(shakeSpeedRamp(ANNIVERSARY, ANNIVERSARY.startSpeed + 1)).toBeLessThan(0.001)
  })

  it('saturates at fullSpeed and stays there', () => {
    expect(shakeSpeedRamp(ANNIVERSARY, ANNIVERSARY.fullSpeed)).toBe(1)
    expect(shakeSpeedRamp(ANNIVERSARY, SHIP.maxSpeed)).toBe(1)
  })

  it('grows with the SQUARE of speed, not with speed', () => {
    // Half way up the ramp in speed is a quarter of the way up in amplitude.
    const mid = (ANNIVERSARY.startSpeed + ANNIVERSARY.fullSpeed) / 2
    expect(shakeSpeedRamp(ANNIVERSARY, mid)).toBeCloseTo(0.25, 10)
  })
})

describe('the gain', () => {
  it('never decreases as the ship speeds up', () => {
    let last = -1
    for (let v = 0; v <= SHIP.maxSpeed; v += 0.5) {
      const g = cockpitShakeGain(ANNIVERSARY, 1, v).translate
      expect(g).toBeGreaterThanOrEqual(last)
      last = g
    }
  })

  it('steps by the boost stage, with the speed ramp held flat', () => {
    // Isolating the step: a preset whose ramp saturates BELOW the first boost
    // floor is at 1 in every stage, so what is left is the stage gain alone.
    const flat: EditionCockpitShake = {
      ...ANNIVERSARY,
      startSpeed: 0,
      fullSpeed: BOOST_STAGE_SPEEDS[0] - 20,
      stageGain: [1, 2, 3, 4],
    }
    const at = (v: number) => cockpitShakeGain(flat, 1, v).translate / flat.amplitude
    expect(at(BOOST_STAGE_SPEEDS[0] - 1)).toBeCloseTo(1, 10)
    expect(at(BOOST_STAGE_SPEEDS[0] + 1)).toBeCloseTo(2, 10)
    expect(at(BOOST_STAGE_SPEEDS[1] + 1)).toBeCloseTo(3, 10)
    expect(at(BOOST_STAGE_SPEEDS[2] + 1)).toBeCloseTo(4, 10)
  })

  it('is zero when the feature is off, whatever the numbers say', () => {
    const off: EditionCockpitShake = { ...ANNIVERSARY, enabled: false }
    expect(cockpitShakeGain(off, 1, SHIP.maxSpeed)).toEqual({ translate: 0, rotate: 0 })
  })
})

describe('the comfort slider multiplies, and light means HALF', () => {
  it('scales every channel linearly', () => {
    // ANNIVERSARY.md §2.6: everything that creates a sense of speed does it by
    // increasing optic flow, and optic flow IS vection. The features move
    // together on one slider or the slider is a lie — and `light` has to be a
    // real halving, not a rounding (`SPEED_FX_SCALE`, `game/edition.ts`).
    const full = channels(sample(ANNIVERSARY, 1, 4.25, 300))
    const light = channels(sample(ANNIVERSARY, 0.5, 4.25, 300))
    for (let i = 0; i < full.length; i++) expect(light[i]).toBeCloseTo((full[i] ?? 0) / 2, 12)
    expect(full.some((v) => Math.abs(v) > 1e-6)).toBe(true)
  })

  it('draws nothing at all with the slider off', () => {
    expect(channels(sample(ANNIVERSARY, 0, 4.25, 300))).toEqual([0, 0, 0, 0, 0])
  })
})

describe('the waveform', () => {
  it('stays inside the ceilings over a full sweep of speed and time', () => {
    const worst = Math.max(...ANNIVERSARY.stageGain)
    const maxTranslate = ANNIVERSARY.amplitude * worst
    const maxRotate = ANNIVERSARY.angle * worst
    const s = createShakeSample()
    // The worst case over the sweep, then five assertions — rather than five
    // assertions per sample, which is 700,000 of them and six seconds.
    let peakTranslate = 0
    let peakRotate = 0
    for (let v = 0; v <= SHIP.maxSpeed; v += 7) {
      for (let t = 0; t < 30; t += 0.013) {
        sampleCockpitShake(s, ANNIVERSARY, 1, t, v, true)
        peakTranslate = Math.max(peakTranslate, Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))
        peakRotate = Math.max(peakRotate, Math.abs(s.roll), Math.abs(s.pitch))
      }
    }
    expect(peakTranslate).toBeLessThanOrEqual(maxTranslate)
    expect(peakRotate).toBeLessThanOrEqual(maxRotate)
    // And it must actually get somewhere near them, or the ceiling is being
    // respected by a signal that does nothing.
    expect(peakTranslate).toBeGreaterThan(maxTranslate * 0.5)
    expect(peakRotate).toBeGreaterThan(maxRotate * 0.5)
  })

  it('gives the same answer for the same time, twice', () => {
    expect(channels(sample(ANNIVERSARY, 1, 12.75, 260))).toEqual(
      channels(sample(ANNIVERSARY, 1, 12.75, 260)),
    )
  })

  it('is CONTINUOUS in time, which is what makes it air rather than a strobe', () => {
    // The guard that would catch someone replacing the sines with a per-frame
    // `Math.random()`: a random draw a millisecond later is a full-amplitude
    // jump, and a sine is a millisecond's worth of motion.
    const gain = cockpitShakeGain(ANNIVERSARY, 1, 300).translate
    const a = sample(ANNIVERSARY, 1, 8, 300)
    const b = sample(ANNIVERSARY, 1, 8.001, 300)
    expect(Math.abs(b.x - a.x)).toBeLessThan(gain * 0.1)
    expect(Math.abs(b.y - a.y)).toBeLessThan(gain * 0.1)
  })

  it('has no clock and no randomness of its own', () => {
    // It takes `time` as an argument for the same reason the sim takes `dt`:
    // a signal you can call twice with the same number is a signal you can
    // assert on. Read off the shipped source, not off a belief about it —
    // and off the CODE, because the first version of this test failed on the
    // module's own comment saying it uses no `Math.random()`.
    const src = code(fs.readFileSync('src/game/cockpit-shake.ts', 'utf8'))
    for (const forbidden of ['Math.random', 'Date.now', 'performance.now']) {
      expect(src).not.toContain(forbidden)
    }
    // The loud counterpart: a stripper that ate everything would pass that.
    expect(src).toContain('Math.sin')
  })

  it('moves the five channels independently', () => {
    // A phase bug that gave every channel the same waveform would slide the
    // cockpit along one diagonal line — which looks like a loose mount, not
    // like buffeting. Nothing else in the suite would notice: the bounds, the
    // scaling and the ramp are all still correct in that world.
    const s = sample(ANNIVERSARY, 1, 3.5, 400)
    const normalised = [
      s.x / ANNIVERSARY.amplitude,
      s.y / ANNIVERSARY.amplitude,
      s.z / ANNIVERSARY.amplitude,
      s.roll / ANNIVERSARY.angle,
      s.pitch / ANNIVERSARY.angle,
    ]
    for (let i = 0; i < normalised.length; i++) {
      for (let j = i + 1; j < normalised.length; j++) {
        expect(Math.abs((normalised[i] ?? 0) - (normalised[j] ?? 0))).toBeGreaterThan(1e-6)
      }
    }
  })
})

describe('the three situations with a speed and no air', () => {
  it('draws nothing when the caller says the ship is not flying', () => {
    // The hangar, the pause menu and the elevator ride. All three can have a
    // non-zero body velocity — the seat is parked but the body is live, the
    // paused ship is frozen mid-flight at 300 m/s, the lift is going straight
    // up — so none of them can be inferred from speed.
    for (const speed of [0, 150, 300, SHIP.maxSpeed]) {
      expect(channels(sample(ANNIVERSARY, 1, 9.5, speed, false))).toEqual([0, 0, 0, 0, 0])
    }
  })
})

// ── 4. the rule: the cockpit moves, the camera does not ───────────────────

/** The body of a named function or method, by brace matching. Throws if it moves. */
const bodyOf = (src: string, header: string): string => {
  const at = src.indexOf(header)
  expect(at, `not found in source: ${header}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  const start = src.indexOf('{', at)
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start + 1, i)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/**
 * Anything that would mean the shake had reached past the art pivot.
 *
 * Whole words, not substrings: `rig` is inside "origin" and "trigger", and the
 * first version of this list failed on a comment about a node sitting at the
 * origin. Matched against `code()`, so prose cannot trip it either.
 */
const OFF_LIMITS: readonly RegExp[] = [
  /\bcamera\b/,
  /\brig\b/,
  /\bbody\b/,
  /\bobject\.position\b/,
  /\bobject\.quaternion\b/,
]

const FLIGHT_FILES = ['src/game/flight.ts', 'src/game/jumpseat-flight.ts'] as const

describe('the shake can only reach the art pivot — in the shipped source', () => {
  for (const file of FLIGHT_FILES) {
    const src = code(fs.readFileSync(file, 'utf8'))

    it(`${file}: applyPivot writes the pivot and nothing else`, () => {
      const body = bodyOf(src, 'const applyPivot = (): void =>')
      // It is a guard only if the thing it guards is actually there. An empty
      // function passes every denylist ever written. Since DEV-365 both
      // vehicles pose the pivot through `game/art-pivot.ts`, guarded below.
      expect(body).toContain('poseArtPivot(artPivot,')
      for (const word of OFF_LIMITS) expect(body, `${word}`).not.toMatch(word)
    })

    it(`${file}: shake() touches the sample and the pivot, and stops`, () => {
      // The DEV-364 follow-up added the hit's `jolt`, which is the sample's too.
      const body = bodyOf(src, 'shake(shake, scale, time, forwardSpeed, active, jolt = 0)')
      expect(body).toContain('sampleCockpitShake(')
      expect(body).toContain('applyPivot()')
      for (const word of OFF_LIMITS) expect(body, `${word}`).not.toMatch(word)
    })

    it(`${file}: the panels hang off the SHIP group, not the pivot`, () => {
      // A readout that buffets with the airframe is fine and even good. A PAUSE
      // PLATE that does is not — it is a menu you aim at with your head. They
      // are all on `object`, which is why the shake cannot reach them, and this
      // is the line that would go quiet if someone reparented one.
      for (const panel of ['results', 'pause', 'briefing']) {
        expect(src).toContain(`object.add(${panel}.object)`)
        expect(src).not.toContain(`artPivot.add(${panel}.object)`)
      }
    })

    // DEV-362. The HoverJet's READOUT is the exception, and on purpose: it is
    // set into the dash's recess, so it must lean and buffet WITH the dash or
    // it slides out of its bezel (`game/flight.ts` says why; the e2e
    // `hud-recess.spec.ts` measures it against the cockpit mesh while leaning).
    // The JumpSeat's stands free in front of its shell and stays on the ship.
    it(`${file}: the readout hangs where its vehicle's dash is`, () => {
      const onPivot = file === 'src/game/flight.ts'
      expect(src).toContain(onPivot ? 'artPivot.add(hud.object)' : 'object.add(hud.object)')
      expect(src).not.toContain(onPivot ? 'object.add(hud.object)' : 'artPivot.add(hud.object)')
    })
  }

  it('src/game/art-pivot.ts: poseArtPivot writes the node it is handed and nothing else', () => {
    const body = bodyOf(
      code(fs.readFileSync('src/game/art-pivot.ts', 'utf8')),
      'export const poseArtPivot = (',
    )
    expect(body).toContain('node.rotation.set(')
    expect(body).toContain('node.position.set(')
    for (const word of OFF_LIMITS) expect(body, `${word}`).not.toMatch(word)
  })

  it('the denylist would actually fail', () => {
    // The guard on the guard. A `not.toMatch` chain that never fires is not a
    // test, it is a comment — and this one would pass on a file that had been
    // emptied by a bad merge.
    expect(OFF_LIMITS.some((w) => w.test('rig.position.copy(eyeWorld)'))).toBe(true)
    expect(OFF_LIMITS.some((w) => w.test('camera.quaternion.copy(q)'))).toBe(true)
    // And it must NOT fire on the words that merely contain them, or the guard
    // is a tripwire across a doorway people use.
    expect(OFF_LIMITS.some((w) => w.test('this node sits at the origin'))).toBe(false)
    expect(OFF_LIMITS.some((w) => w.test('artPivot.rotation.set(0, 0, 0)'))).toBe(false)
  })
})

describe('the eye does not inherit the pivot — the case that separates the two stories', () => {
  /**
   * The HoverJet's hierarchy, from `flight.ts`'s own exported constants.
   *
   * The claim under test is NOT "the shake is small" — a shake of any size
   * satisfies "the camera did not move" if the camera is all you measure. It is
   * that `art_pivot` sits off the camera's path, which is DEV-010's whole point
   * and the seam this feature was built on. So the test builds the marker that
   * WOULD move under the other story — an eye parented to the pivot — and shows
   * the two disagree. CLAUDE.md's agreement lesson: ask what case makes your
   * rule and the alternative give different answers.
   */
  const build = () => {
    const object = new THREE.Group()
    const artPivot = new THREE.Group()
    const art = new THREE.Object3D()
    // In the pivot's frame, at 2016's pivot, as `flight.ts` hangs it (DEV-365).
    art.position.copy(onPivot(ART_POSITION, ART_PIVOT))
    art.rotation.y = SHIP_MODEL_YAW
    art.scale.copy(ART_SCALE)
    artPivot.add(art)
    object.add(artPivot)
    // The counterfactual: what the eye would be if it hung off the pivot the
    // way the art does. 2016 parents `CameraRoot_FirstPerson` to `shipOffset`
    // instead, and that one line is the reason a cockpit shake is safe at all.
    const inheritedEye = new THREE.Object3D()
    inheritedEye.position.copy(onPivot(EYE, ART_PIVOT))
    artPivot.add(inheritedEye)
    // At rest, where the pivot stands, so "before" is the art where it is drawn.
    poseArtPivot(artPivot, ART_PIVOT, 0, 0, createShakeSample())
    // A pose that is not the identity in any axis, so a dropped rotation or a
    // missed parent shows up rather than cancelling.
    object.position.set(1234.5, 678.9, -246.8)
    object.quaternion.setFromEuler(new THREE.Euler(0.3, -1.1, 0.7, 'ZXY'))
    return { object, artPivot, art, inheritedEye }
  }

  /** The eye, exactly as `Flight.render()` derives it: from `object` alone. */
  const eyeOf = (object: THREE.Object3D) =>
    EYE.clone().applyQuaternion(object.quaternion).add(object.position)

  it('moves the cockpit and leaves the eye where it was', () => {
    const { object, artPivot, art, inheritedEye } = build()
    object.updateMatrixWorld(true)
    const eyeBefore = eyeOf(object)
    const artBefore = art.getWorldPosition(new THREE.Vector3())
    const counterfactualBefore = inheritedEye.getWorldPosition(new THREE.Vector3())

    // A deliberately ENORMOUS buffet — a hundred times the preset's ceiling.
    // If the eye survives this it survives anything the preset can ask for, and
    // a test at 5 mm could pass on a hierarchy that was quietly wrong.
    const sampled = sample(
      { ...ANNIVERSARY, amplitude: 0.5, angle: 0.35, stageGain: [1, 1, 1, 1] },
      1,
      2.5,
      SHIP.maxSpeed,
    )
    // Through the game's own pose, with no lean: the buffet alone.
    poseArtPivot(artPivot, ART_PIVOT, 0, 0, sampled)
    object.updateMatrixWorld(true)

    // The cockpit moved. Millimetres would prove nothing, so assert it moved by
    // an amount a person would see.
    expect(art.getWorldPosition(new THREE.Vector3()).distanceTo(artBefore)).toBeGreaterThan(0.01)
    expect(
      inheritedEye.getWorldPosition(new THREE.Vector3()).distanceTo(counterfactualBefore),
    ).toBeGreaterThan(0.01)

    // And the eye did not. Exactly, not approximately: it is not computed from
    // the pivot at all, so there is no rounding to allow for.
    expect(eyeOf(object).equals(eyeBefore)).toBe(true)
  })
})

// ── 5. DEV-426: the buffet follows the ENGINE ────────────────────────────
//
// Matt, 2026-09-26: "0.6x the current jitter at full throttle and then 1x the
// jitter at boost, and then fade back to 0.8x jitter once at top speed.
// (multiplier is amplitude, not speed)". Three claims, three kinds of evidence:
// the numbers are his (pinned by value), the curve is the one
// `game/cockpit-shake.ts` writes down (its corners, as a function), and a REAL
// jet flying full throttle -> boost -> top speed walks that curve (the sim, not
// a hand-built engine). The last one also flies a long chain, the case where
// "top speed" as the chain's live terminal and "top speed" as 2016's 180 m/s
// give different answers — at no chain the two agree, so a test there could
// not tell which the code believes.
//
// DEV-528 (Matt, 2026-09-29: "old jitter was better. (before my suggestion)")
// set the SHIPPED weights to 1 / 1 / 1, which makes the curve flat. So the
// curve's own tests below fly DEV-426's numbers as a FIXTURE: they test the
// mechanism Matt will shape later, and a flat curve could not tell a right one
// from a wrong one. What ships is pinned once, by value, and flown against the
// buffet with no curve at all.

/** DEV-426's numbers, as it shipped them 2026-09-26: the curve under test. */
const THROTTLE: EditionShakeThrottle = { fullThrottle: 0.6, boost: 1, topSpeed: 0.8 }
/** What the Anniversary preset ships. */
const SHIPPED = ANNIVERSARY.throttle as EditionShakeThrottle

/** An engine at `ratio` of full-throttle thrust, with 2016's no-chain terminals. */
const engineAt = (ratio: number): ShakeEngine => ({
  thrustRatio: ratio,
  boostMultiplier: SHIP.boostMultiplier,
  cruiseSpeed: cruiseSpeed(HOVERJET, SHIP.maxSpeed),
  topSpeed: cruiseSpeed(HOVERJET, SHIP.maxSpeed * SHIP.boostMultiplier),
})

describe('DEV-426: the numbers are Matt s, and only Anniversary has them', () => {
  it('pins the shipped weights by value: 1 / 1 / 1 since DEV-528', () => {
    // His call both times, not a first guess: moving one is a conversation
    // with him, and this is the line that makes it a deliberate edit. DEV-426
    // shipped 0.6 / 1 / 0.8; DEV-528 put the buffet back to DEV-083's.
    expect(SHIPPED.fullThrottle).toBe(1)
    expect(SHIPPED.boost).toBe(1)
    expect(SHIPPED.topSpeed).toBe(1)
  })

  it('leaves Classic without a curve, so its buffet (off) is untouched', () => {
    expect((CLASSIC as { throttle?: unknown }).throttle).toBeUndefined()
    expect(throttleShakeGain(CLASSIC.throttle, engineAt(2), 150)).toBe(1)
  })

  it('refuses a weight that is not a number, or is negative, at load', () => {
    const edition = (w: number) => {
      const e = JSON.parse(JSON.stringify(anniversaryJson)) as Edition
      ;(e.cockpit.shake.throttle as { boost: number }).boost = w
      return e
    }
    expect(() => validateEdition(edition(Number.NaN))).toThrow(/cockpit\.shake\.throttle\.boost/)
    expect(() => validateEdition(edition(-0.1))).toThrow(/cockpit\.shake\.throttle\.boost/)
    expect(validateEdition(edition(0)).id).toBe('anniversary')
  })

  it('declares the block in the schema, and refuses a key nobody declared', () => {
    const schema = schemaJson as unknown as SchemaNode
    const validate = createValidator(schema)
    const e = JSON.parse(JSON.stringify(anniversaryJson)) as {
      cockpit: { shake: { throttle: Record<string, unknown> } }
    }
    const ok: string[] = []
    validate(schema, e, 'anniversary', ok)
    expect(ok, ok.join('\n')).toEqual([])
    e.cockpit.shake.throttle.idleNobodyDeclared = 0.3
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('idleNobodyDeclared')
  })
})

describe('DEV-426: the curve, as a function', () => {
  const { cruiseSpeed: cruise, topSpeed: top } = engineAt(1)
  const at = (ratio: number, speed: number) => throttleShakeGain(THROTTLE, engineAt(ratio), speed)

  it('is 0.6 at full throttle, unboosted, at every speed — and below full throttle', () => {
    for (const v of [0, 40, cruise, 150, top, 400]) {
      expect(at(1, v)).toBeCloseTo(0.6, 12)
      expect(at(0.5, v)).toBeCloseTo(0.6, 12)
      expect(at(0, v)).toBeCloseTo(0.6, 12)
    }
  })

  it('is 1 on a full boost at the unboosted terminal, where a boost from full throttle starts', () => {
    expect(at(SHIP.boostMultiplier, cruise)).toBeCloseTo(1, 12)
    // And below it: a boost from a standstill has not begun to fade.
    expect(at(SHIP.boostMultiplier, 0)).toBeCloseTo(1, 12)
  })

  it('is 0.8 boosting at top speed, and stays there past it', () => {
    expect(at(SHIP.boostMultiplier, top)).toBeCloseTo(0.8, 12)
    // A chain that drops leaves the ship above its new top speed.
    expect(at(SHIP.boostMultiplier, top + 150)).toBeCloseTo(0.8, 12)
  })

  it('fades LINEARLY in speed between the two terminals', () => {
    expect(at(SHIP.boostMultiplier, (cruise + top) / 2)).toBeCloseTo(0.9, 12)
    expect(at(SHIP.boostMultiplier, cruise + (top - cruise) / 4)).toBeCloseTo(0.95, 12)
  })

  it('weighs a half-spooled boost half way, by thrust rather than by the button', () => {
    const half = 1 + (SHIP.boostMultiplier - 1) / 2
    expect(at(half, cruise)).toBeCloseTo(0.8, 12)
    expect(boostWeight(engineAt(half))).toBeCloseTo(0.5, 12)
  })

  it('never leaves the span of the three numbers, and a NaN engine is a weight of 0.6', () => {
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (let r = -1; r <= 4; r += 0.05) {
      for (let v = -50; v <= 500; v += 5) {
        const g = at(r, v)
        low = Math.min(low, g)
        high = Math.max(high, g)
      }
    }
    expect(low).toBeCloseTo(0.6, 12)
    expect(high).toBeCloseTo(1, 12)
    const broken = { ...engineAt(Number.NaN), topSpeed: Number.NaN }
    expect(throttleShakeGain(THROTTLE, broken, Number.NaN)).toBeCloseTo(0.6, 12)
    expect(topSpeedWeight(broken, 100)).toBe(0)
  })

  it('is 1 with no curve or no engine to read', () => {
    expect(throttleShakeGain(undefined, engineAt(2), 150)).toBe(1)
    expect(throttleShakeGain(THROTTLE, null, 150)).toBe(1)
  })
})

describe('DEV-426: it multiplies the AMPLITUDE of the buffet, and nothing else', () => {
  const at = (time: number, speed: number, jolt: number, engine?: number) =>
    channels(
      engine === undefined
        ? sampleCockpitShake(createShakeSample(), ANNIVERSARY, 1, time, speed, true, jolt)
        : sampleCockpitShake(createShakeSample(), ANNIVERSARY, 1, time, speed, true, jolt, engine),
    )

  it('scales every channel by exactly the gain, at the same instant', () => {
    // "multiplier is amplitude, not speed": the waveform keeps its timing and
    // its speed ramp, and every channel is the same fraction of itself.
    const full = at(6.2, 260, 0, 1)
    const part = at(6.2, 260, 0, 0.6)
    expect(full.some((v) => Math.abs(v) > 1e-6)).toBe(true)
    for (let i = 0; i < full.length; i++) expect(part[i]).toBeCloseTo(0.6 * (full[i] ?? 0), 14)
  })

  it('leaves a racer s hit alone: the jolt is not the engine', () => {
    // The jolt's share of the sample is the same whatever the engine weighs.
    const joltAtFull = at(6.2, 260, 0.8, 1).map((v, i) => v - (at(6.2, 260, 0, 1)[i] ?? 0))
    const joltAtPart = at(6.2, 260, 0.8, 0.6).map((v, i) => v - (at(6.2, 260, 0, 0.6)[i] ?? 0))
    expect(joltAtFull.some((v) => Math.abs(v) > 1e-6)).toBe(true)
    for (let i = 0; i < joltAtFull.length; i++) {
      expect(joltAtPart[i]).toBeCloseTo(joltAtFull[i] ?? 0, 14)
    }
  })

  it('is the old buffet when absent, which is what the JumpSeat passes', () => {
    expect(at(3.3, 300, 0)).toEqual(at(3.3, 300, 0, 1))
  })
})

/** Fly `jet` for `seconds` on `input`, reading the gain every tick. */
const flyReading = (
  jet: ReturnType<typeof createHoverJet>,
  input: HoverJetInput,
  seconds: number,
  holdChain: boolean,
): { gains: number[]; speeds: number[]; ratios: number[] } => {
  const engine = createShakeEngine()
  const gains: number[] = []
  const speeds: number[] = []
  const ratios: number[] = []
  const ticks = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < ticks; i++) {
    // Hold the chain as a clean run would: a gate inside every cooldown.
    if (holdChain) jet.chain.sinceGate = 0
    stepHoverJet(jet, input)
    // Identity orientation throughout, so forward speed IS the z velocity.
    const v = jet.body.velocity.z
    speeds.push(v)
    gains.push(throttleShakeGain(THROTTLE, readShakeEngine(jet, engine), v))
    ratios.push(engine.thrustRatio)
  }
  return { gains, speeds, ratios }
}

describe('DEV-426: flown — a real HoverJet walks the curve', () => {
  const run = (stacks: number, boostPower?: number) => {
    const jet = createHoverJet()
    jet.chain.stacks = stacks
    const input = noInput()
    input.throttle = 1
    const cruising = flyReading(jet, input, 12, stacks > 0)
    input.boost = true
    input.boostPower = boostPower
    const boosting = flyReading(jet, input, 12, stacks > 0)
    input.boost = false
    const released = flyReading(jet, input, 1, stacks > 0)
    return { cruising, boosting, released }
  }

  it('cruises at 0.6, peaks near 1 as the boost spools, and settles at 0.8 at top speed', () => {
    const r = run(0)
    expect(r.cruising.speeds.at(-1)).toBeCloseTo(cruiseSpeed(HOVERJET), 3)
    expect(r.cruising.gains.at(-1)).toBeCloseTo(0.6, 12)
    const g = r.boosting.gains
    const peak = Math.max(...g)
    const peakAt = g.indexOf(peak)
    // The spool is 0.25 s at no chain; the speed has begun to rise by then, so
    // the peak is a shade under 1 rather than exactly it.
    expect(peak).toBeGreaterThan(0.95)
    expect(peakAt * FIXED_DT).toBeLessThan(0.3)
    expect(r.boosting.speeds.at(-1)).toBeCloseTo(cruiseSpeed(HOVERJET, SHIP.maxSpeed * 2), 2)
    expect(g.at(-1)).toBeCloseTo(0.8, 3)
    // After the peak it only falls: a fade, not a wobble.
    for (let i = peakAt + 1; i < g.length; i++) {
      expect(g[i]).toBeLessThanOrEqual((g[i - 1] ?? 0) + 1e-12)
    }
    // And back to 0.6 once the engine spools down off the boost.
    expect(r.released.gains.at(-1)).toBeCloseTo(0.6, 12)
  })

  it('never pops: no tick moves it further than the spool allows', () => {
    // Full throttle to a full boost is 0.4 of weight over the spool's
    // `1 / acceleration` seconds. A curve keyed on the BUTTON would jump the
    // whole 0.4 in one tick.
    const r = run(0)
    const perTick = (THROTTLE.boost - THROTTLE.fullThrottle) * SHIP.acceleration * FIXED_DT * 1.05
    const all = [...r.cruising.gains, ...r.boosting.gains, ...r.released.gains]
    let worst = 0
    for (let i = 1; i < all.length; i++) {
      worst = Math.max(worst, Math.abs((all[i] ?? 0) - (all[i - 1] ?? 0)))
    }
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(perTick)
  })

  it('on a 21-gate chain, "top speed" is the chain s terminal and not 2016 s 180', () => {
    // The case that separates the two readings of "top speed". Half way up the
    // live chain's span the ship is ~70 m/s past 2016's unchained 180, so a
    // curve that believed 180 would already sit at 0.8 there; the live chain's
    // terminal puts it at 0.9, and 0.8 arrives only at ~335.
    const r = run(21)
    const full = SHIP.maxSpeed + 21 * HOVERJET.speedChain.speedIncreaseAmt
    const cruiseLive = cruiseSpeed(HOVERJET, full)
    const topLive = cruiseSpeed(HOVERJET, full * 2)
    expect(r.cruising.speeds.at(-1)).toBeCloseTo(cruiseLive, 2)
    expect(r.boosting.speeds.at(-1)).toBeCloseTo(topLive, 1)
    expect(topLive).toBeGreaterThan(330)
    expect(r.cruising.gains.at(-1)).toBeCloseTo(0.6, 12)
    expect(r.boosting.gains.at(-1)).toBeCloseTo(0.8, 2)
    const half = r.boosting.speeds.findIndex((v) => v >= (cruiseLive + topLive) / 2)
    expect(half).toBeGreaterThan(0)
    // The premises: the spool is done (so the boost weight is 1 and only the
    // fade is left), and the ship is well past the unchained top.
    expect(r.boosting.ratios[half]).toBeCloseTo(SHIP.boostMultiplier, 9)
    expect(r.boosting.speeds[half]).toBeGreaterThan(cruiseSpeed(HOVERJET, SHIP.maxSpeed * 2) + 60)
    expect(r.boosting.gains[half]).toBeCloseTo(0.9, 2)
  })

  it('weighs a half-paid boost (DEV-410 s empty tank) part of the way', () => {
    // Half the boost's extra thrust weighs b = 0.5, and the ship settles half
    // way from cruise to the full boost's top: 0.6 + 0.5 * (0.9 - 0.6).
    const r = run(0, 0.5)
    expect(r.boosting.gains.at(-1)).toBeCloseTo(0.75, 3)
  })
})

describe('DEV-426: wired where the buffet is, and only there', () => {
  const flight = code(fs.readFileSync('src/game/flight.ts', 'utf8'))
  const seat = code(fs.readFileSync('src/game/jumpseat-flight.ts', 'utf8'))
  const SHAKE = 'shake(shake, scale, time, forwardSpeed, active, jolt = 0)'

  it('the HoverJet s shake() reads its own engine and hands the weight to the sample', () => {
    const body = bodyOf(flight, SHAKE)
    expect(body).toContain('shake.throttle')
    expect(body).toContain('readShakeEngine(shakeJet, shakeEngine)')
    expect(body).toContain(
      'sampleCockpitShake(buffet, shake, scale, time, forwardSpeed, active, jolt, engineGain)',
    )
  })

  it('the JumpSeat s passes no weight, so it buffets on speed alone as DEV-083 built it', () => {
    expect(bodyOf(seat, SHAKE)).toContain(
      'sampleCockpitShake(buffet, shake, scale, time, forwardSpeed, active, jolt)',
    )
  })

  it('reaches the game whole: the release channel and a headset keep the curve', () => {
    // `boot/app.ts` hands `editionState.current.cockpit.shake` to `shake()`
    // (unchanged by DEV-426), and what is `current` has been through the
    // loader's `forChannel` and, in a session, `applyVrOverrides`. Both copy;
    // neither may drop a nested key the curve lives in.
    const loaded = validateEdition(JSON.parse(JSON.stringify(anniversaryJson)) as Edition)
    const release = forChannel(loaded, 'release')
    expect(release.cockpit.shake.throttle).toEqual(anniversaryJson.cockpit.shake.throttle)
    expect(applyVrOverrides(release).cockpit.shake.throttle).toEqual(
      anniversaryJson.cockpit.shake.throttle,
    )
  })

  it('reads the engine a jet actually has: the glider has none', () => {
    // `hoverJetOf`'s test, for the same reason: the glider's `jet` is a body
    // and an inert chain, with no spool to read.
    expect(flight).toContain("const shakeJet = 'currentThrust' in jet ? (jet as HoverJet) : null")
  })
})

// ── 6. DEV-528: the shipped buffet is DEV-083's again ───────────────────────

describe('DEV-528: the shipped weights give the buffet exactly as it was before DEV-426', () => {
  it('flown full throttle -> boost -> release, on a chain: every sample equals the no-curve buffet', () => {
    // "Exactly" is the claim, so toEqual on every channel of every tick, and a
    // real jet so the engine walks every state the curve reads. The chain is
    // held so top speed moves too.
    const jet = createHoverJet()
    jet.chain.stacks = 21
    const engine = createShakeEngine()
    const input = noInput()
    input.throttle = 1
    let compared = 0
    let moving = 0
    const fly = (seconds: number): void => {
      for (let i = 0, n = Math.round(seconds / FIXED_DT); i < n; i++) {
        jet.chain.sinceGate = 0
        stepHoverJet(jet, input)
        const v = jet.body.velocity.z
        const gain = throttleShakeGain(SHIPPED, readShakeEngine(jet, engine), v)
        expect(gain).toBe(1)
        const t = i * FIXED_DT
        const weighed = channels(
          sampleCockpitShake(createShakeSample(), ANNIVERSARY, 1, t, v, true, 0, gain),
        )
        const bare = channels(
          sampleCockpitShake(createShakeSample(), ANNIVERSARY, 1, t, v, true, 0),
        )
        expect(weighed).toEqual(bare)
        compared++
        if (bare.some((c) => Math.abs(c) > 1e-6)) moving++
      }
    }
    fly(8)
    input.boost = true
    fly(10)
    input.boost = false
    fly(2)
    // The premise: the buffet was actually moving for most of it, so the
    // equality is not two zeros agreeing.
    expect(moving).toBeGreaterThan(compared / 2)
  })
})

describe('DEV-528: the ?lookdev=1 group for the three weights', () => {
  it('flies the preset untouched, and the panel s weights once a slider moves', () => {
    const lookdev = createShakeLookdev()
    const group = lookdev.group(ANNIVERSARY, 'anniversary')
    expect(group).not.toBeNull()
    // Open and untouched: the very object the preset holds.
    expect(lookdev.shake(ANNIVERSARY)).toBe(ANNIVERSARY)
    const full = group?.controls.find((c) => c.source.endsWith('throttle.fullThrottle = %'))
    expect(full?.get()).toBe(SHIPPED.fullThrottle)
    full?.set(0.6)
    const flown = lookdev.shake(ANNIVERSARY)
    expect(flown.throttle?.fullThrottle).toBe(0.6)
    expect(flown.throttle?.topSpeed).toBe(SHIPPED.topSpeed)
    // The preset itself is never written.
    expect(SHIPPED.fullThrottle).toBe(1)
    // Cached: a second frame gets the same object, not a new one.
    expect(lookdev.shake(ANNIVERSARY)).toBe(flown)
    // The paste is the whole block at its path.
    expect(group?.json?.path).toContain('cockpit.shake.throttle')
    expect(group?.json?.value()).toMatchObject({ fullThrottle: 0.6, boost: 1, topSpeed: 1 })
    // A new world starts from the preset again.
    lookdev.group(ANNIVERSARY, 'anniversary')
    expect(lookdev.shake(ANNIVERSARY)).toBe(ANNIVERSARY)
  })

  it('is absent where it would be inert: Classic has no curve and no buffet', () => {
    expect(createShakeLookdev().group(CLASSIC, 'classic')).toBeNull()
  })
})
