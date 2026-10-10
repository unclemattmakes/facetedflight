// tests/unit/speed-line-ramp.test.ts — the speed lines RAMP instead of
// switching (DEV-351), and Classic keeps 2016's three cuts.
//
// **What this file can claim.** That the ramp is zero at rest, never falls as
// the ship speeds up in any of the three channels Matt named (count, alpha,
// speed), has no step anywhere a player can fly, crossfades at 2016's cuts,
// passes THROUGH the generated sheet rather than near it, and never exceeds it;
// that the comfort slider's 0 turns it off and every other setting draws it
// whole; that Classic resolves to the cut path at every slider value; and that
// an undriven particle field is the field it always was, to the bit.
//
// **What it cannot claim.** That the ramp READS — that 60 m/s is the right
// onset, or that the floors are right. That is a burst of frames through an
// acceleration, and then Matt in the seat (the DEVIATIONS row has the frames).
//
// Every speed and rate here comes off the generated sheet, through the same
// named keys the game reads; nothing is typed in (hard rule 3, DEV-069).

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { EditionSpeedRamp } from '@/content/edition-schema'
import { speedFxScale } from '@/game/edition'
import {
  boostStageAt,
  hoverJetSpeedLineStages,
  SPEED_LINE_CUT_KEYS,
  type SpeedLineDrive,
  type SpeedLineRamp,
  speedLineDrives,
  speedLineRamp,
  stageMiddles,
} from '@/game/speed-line-ramp'
import { HOVERJET } from '@/generated/constants.generated'
import {
  createParticleField,
  evaluateMinMax,
  type MinMaxCurveLike,
  NO_DRIVE,
  type ParticleField,
  type ParticleSpec,
} from '@/render/particles'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

interface ShipParticle extends ParticleSpec {
  readonly fileId: string
  readonly position: readonly number[]
  readonly ancestors: readonly { readonly name: string; readonly position: readonly number[] }[]
}
const SHIP_PARTICLES = HOVERJET.particles as unknown as ShipParticle[]
const SHIP = HOVERJET.ship as unknown as Record<string, { ref?: { fileID?: string } } | number>

/** The spec behind one of `HOVERJET.ship`'s particle references, as the game resolves it. */
const specFor = (key: string): ShipParticle => {
  const ref = SHIP[key]
  const id = typeof ref === 'object' ? ref.ref?.fileID : undefined
  const p = SHIP_PARTICLES.find((s) => s.fileId === id)
  if (!p) throw new Error(`no particle behind HOVERJET.ship.${key}`)
  return p
}
const BOOST = [
  specFor('boostEffects'),
  specFor('boostEffects_stage2'),
  specFor('boostEffects_stage3'),
] as const
/** Each stage's AUTHORED emission rate, per second. */
const AUTHORED_RATE = BOOST.map((s) => evaluateMinMax(s.emission?.rate, 0, 0))

const STAGES = hoverJetSpeedLineStages()
const [CUT1, CUT2, CUT3] = STAGES.cuts
const TOP = STAGES.top
const MIDDLES = stageMiddles(STAGES)

const ANNIVERSARY = anniversary.fx.speedRamp as EditionSpeedRamp
const CLASSIC = classic.fx.speedRamp as EditionSpeedRamp
/** The shipped preset's ramp at full — the thing the sweeps are about. */
const RAMP = speedLineRamp(ANNIVERSARY, 1) as SpeedLineRamp

/** Particles born per second across the three stages, under `drives`. */
const bornPerSecond = (drives: readonly SpeedLineDrive[]): number =>
  drives.reduce((n, d, i) => n + d.rate * (AUTHORED_RATE[i] as number), 0)

/** 2016's staircase, as particles per second: exactly one stage at its authored rate. */
const classicBornPerSecond = (v: number): number => {
  const stage = boostStageAt(v, STAGES)
  return stage === 0 ? 0 : (AUTHORED_RATE[stage - 1] as number)
}

/** A sweep past the top, fine enough that a step cannot hide between samples. */
const SWEEP_STEP = 0.25
const sweep = (): number[] => {
  const out: number[] = []
  for (let v = 0; v <= TOP + 100; v += SWEEP_STEP) out.push(v)
  return out
}

describe('2016, off the sheet', () => {
  it('reads the three cuts and the top from the named prefab keys', () => {
    // A relationship, not a re-derivation: the stages the game builds are the
    // numbers on the sheet under 2016's own field names, in order.
    SPEED_LINE_CUT_KEYS.forEach((key, i) => {
      expect(STAGES.cuts[i], key).toBe(SHIP[key])
    })
    expect(STAGES.top).toBe(SHIP.maxSpeed)
    expect(CUT1).toBeLessThan(CUT2)
    expect(CUT2).toBeLessThan(CUT3)
    expect(CUT3).toBeLessThan(TOP)
  })

  it('authors each stage at a HIGHER rate than the one before — the premise of a rising count', () => {
    // If a future extraction ever made these fall, a crossfade between them
    // would thin the lines as the ship sped up, and the sweep below would say so.
    expect(AUTHORED_RATE[0]).toBeGreaterThan(0)
    expect(AUTHORED_RATE[1]).toBeGreaterThan(AUTHORED_RATE[0] as number)
    expect(AUTHORED_RATE[2]).toBeGreaterThan(AUTHORED_RATE[1] as number)
  })
})

describe('Classic keeps the three cuts, to the bit', () => {
  it('resolves to the cut path at every slider setting', () => {
    expect(CLASSIC.enabled).toBe(false)
    for (const k of [0, speedFxScale('light'), speedFxScale('full')]) {
      expect(speedLineRamp(CLASSIC, k), `speedFx ${k}`).toBeNull()
    }
  })

  it("is Ship_HoverShip.Update()'s choice: nothing below the first cut, one stage from each cut up", () => {
    // Just below each cut is the stage before it; ON the cut is the stage it
    // opens — `<`, as the port has always compared.
    const below = (x: number): number => x - 1e-6
    expect(boostStageAt(0, STAGES)).toBe(0)
    expect(boostStageAt(below(CUT1), STAGES)).toBe(0)
    expect(boostStageAt(CUT1, STAGES)).toBe(1)
    expect(boostStageAt(below(CUT2), STAGES)).toBe(1)
    expect(boostStageAt(CUT2, STAGES)).toBe(2)
    expect(boostStageAt(below(CUT3), STAGES)).toBe(2)
    expect(boostStageAt(CUT3, STAGES)).toBe(3)
    expect(boostStageAt(TOP, STAGES)).toBe(3)
  })

  it('an undriven field is byte-identical to one driven at NO_DRIVE or reset with null', () => {
    // The engine half of "to the bit". Classic never calls `setDrive`, and a
    // flip back from Anniversary calls `setDrive(null)`; both must leave the
    // field the field it was before DEV-351 — same rand() order, `x * 1`.
    const run = (drive: (f: ParticleField) => void) => {
      const f = createParticleField(BOOST[0], new THREE.Texture(), { capacity: 256 })
      const e = f.addEmitter()
      e.matrix.makeTranslation(3, 40, -7)
      e.play()
      const camera = new THREE.PerspectiveCamera()
      for (let i = 0; i < 90; i++) {
        drive(f)
        f.update(1 / 90, camera)
      }
      const g = (f.object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
      const bits = (name: string) =>
        Array.from(new Uint32Array((g.getAttribute(name).array as Float32Array).slice().buffer))
      const u = ((f.object as THREE.Mesh).material as THREE.ShaderMaterial).uniforms
      return {
        count: g.instanceCount,
        position: bits('iPosition'),
        colour: bits('iColor'),
        params: bits('iParams'),
        velocity: bits('iVelocity'),
        alpha: u.uAlphaScale?.value as number,
      }
    }
    const untouched = run(() => {})
    expect(untouched.count).toBeGreaterThan(0)
    expect(run((f) => f.setDrive(NO_DRIVE))).toEqual(untouched)
    expect(run((f) => f.setDrive(null))).toEqual(untouched)
  })
})

describe('the ramp: nothing at rest, never falling, no step', () => {
  it('is zero at rest and everywhere at or below the onset', () => {
    for (const v of [0, RAMP.onsetSpeed / 2, RAMP.onsetSpeed]) {
      for (const d of speedLineDrives(v, STAGES, RAMP)) {
        expect(d.rate, `rate at ${v}`).toBe(0)
        expect(d.alpha, `alpha at ${v}`).toBe(0)
      }
    }
  })

  it('never makes fewer, fainter or slower streaks as the ship speeds up', () => {
    let prev = speedLineDrives(0, STAGES, RAMP).map((d) => ({ ...d }))
    let prevBorn = bornPerSecond(prev)
    for (const v of sweep()) {
      const now = speedLineDrives(v, STAGES, RAMP)
      const born = bornPerSecond(now)
      expect(born, `particles per second at ${v} m/s`).toBeGreaterThanOrEqual(prevBorn)
      now.forEach((d, i) => {
        expect(d.alpha, `stage ${i + 1} alpha at ${v}`).toBeGreaterThanOrEqual(
          (prev[i] as SpeedLineDrive).alpha,
        )
        expect(d.speed, `stage ${i + 1} speed at ${v}`).toBeGreaterThanOrEqual(
          (prev[i] as SpeedLineDrive).speed,
        )
      })
      prev = now.map((d) => ({ ...d }))
      prevBorn = born
    }
  })

  it('has no step: a quarter m/s never moves the count by a tenth of 2016’s smallest cut', () => {
    // The bound is 2016's own jump, scaled down — and the staircase is run
    // through the SAME measure to show the measure can tell a cut from a ramp.
    const smallestJump = Math.min(
      AUTHORED_RATE[0] as number,
      (AUTHORED_RATE[1] as number) - (AUTHORED_RATE[0] as number),
      (AUTHORED_RATE[2] as number) - (AUTHORED_RATE[1] as number),
    )
    const bound = smallestJump / 10
    let rampWorst = 0
    let cutWorst = 0
    let prevRamp = 0
    let prevCut = 0
    for (const v of sweep()) {
      const ramp = bornPerSecond(speedLineDrives(v, STAGES, RAMP))
      const cut = classicBornPerSecond(v)
      rampWorst = Math.max(rampWorst, Math.abs(ramp - prevRamp))
      cutWorst = Math.max(cutWorst, Math.abs(cut - prevCut))
      prevRamp = ramp
      prevCut = cut
    }
    expect(rampWorst).toBeLessThan(bound)
    expect(cutWorst).toBeGreaterThan(bound)
  })

  it('crossfades at 2016’s cuts: the stages either side are both emitting', () => {
    const at = (v: number) => speedLineDrives(v, STAGES, RAMP)
    const [s1] = at(CUT1)
    expect(s1?.rate).toBeGreaterThan(0)
    expect(s1?.rate).toBeLessThan(1)
    const [a1, a2] = at(CUT2)
    expect(a1?.rate).toBeGreaterThan(0)
    expect(a2?.rate).toBeGreaterThan(0)
    const [, b2, b3] = at(CUT3)
    expect(b2?.rate).toBeGreaterThan(0)
    expect(b3?.rate).toBeGreaterThan(0)
  })

  it('passes THROUGH the sheet: each stage alone, at its authored rate, mid-band', () => {
    MIDDLES.forEach((v, i) => {
      const drives = speedLineDrives(v, STAGES, RAMP)
      drives.forEach((d, j) => {
        expect(d.rate, `stage ${j + 1} at stage ${i + 1}'s middle, ${v} m/s`).toBe(i === j ? 1 : 0)
      })
      expect(bornPerSecond(drives)).toBe(AUTHORED_RATE[i])
    })
    // ...and from stage 1's middle up, the alpha and the spawn speed are 2016's.
    for (const v of [MIDDLES[0], CUT2, CUT3, TOP] as number[]) {
      for (const d of speedLineDrives(v, STAGES, RAMP)) {
        expect(d.alpha).toBe(1)
        expect(d.speed).toBe(1)
      }
    }
  })

  it('never exceeds the sheet in any channel', () => {
    for (const v of sweep()) {
      for (const d of speedLineDrives(v, STAGES, RAMP)) {
        for (const x of [d.rate, d.alpha, d.speed]) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('ramps in from the floors, not from invisible', () => {
    const just = RAMP.onsetSpeed + SWEEP_STEP
    const [d] = speedLineDrives(just, STAGES, RAMP)
    expect(d?.rate).toBeGreaterThan(0)
    expect(d?.alpha).toBeGreaterThanOrEqual(RAMP.alphaFloor)
    expect(d?.speed).toBeGreaterThanOrEqual(RAMP.speedFloor)
    expect(d?.alpha).toBeLessThan(1)
    expect(d?.speed).toBeLessThan(1)
  })

  it('degenerates to a step at stage 1’s middle, not to NaN, when the onset is past it', () => {
    const late: SpeedLineRamp = { ...RAMP, onsetSpeed: (MIDDLES[0] as number) + 50 }
    for (const v of sweep()) {
      for (const d of speedLineDrives(v, STAGES, late)) {
        expect(Number.isFinite(d.rate) && Number.isFinite(d.alpha)).toBe(true)
      }
    }
    expect(speedLineDrives((MIDDLES[0] as number) - 1, STAGES, late)[0]?.rate).toBe(0)
    expect(speedLineDrives(MIDDLES[0] as number, STAGES, late)[0]?.rate).toBe(1)
  })
})

describe('the comfort slider', () => {
  it('turns the ramp OFF at 0, the way it turns S2 off', () => {
    expect(ANNIVERSARY.enabled).toBe(true)
    expect(speedLineRamp(ANNIVERSARY, speedFxScale('off'))).toBeNull()
    expect(speedLineRamp(ANNIVERSARY, Number.NaN)).toBeNull()
    expect(speedLineRamp(ANNIVERSARY, -1)).toBeNull()
  })

  it('draws the WHOLE ramp at light and at full — a half-ramp would be a half-cut', () => {
    expect(speedLineRamp(ANNIVERSARY, speedFxScale('light'))).toEqual(
      speedLineRamp(ANNIVERSARY, speedFxScale('full')),
    )
  })

  it('is on for a player who never opens the comfort menu', () => {
    // `light` is the default, which is why it cannot be allowed to bring a cut back.
    expect(speedLineRamp(ANNIVERSARY, speedFxScale(DEFAULT_SETTINGS.speedFx))).not.toBeNull()
  })
})

describe('the engine applies a drive', () => {
  const texture = new THREE.Texture()
  const camera = new THREE.PerspectiveCamera()
  /**
   * Stage 1's spec with its particles made IMMORTAL, so the live count is the
   * birth count exactly and the rate can be read without a death term in it.
   * Its `maxParticles` goes up with the pool: since DEV-417 an emitter stops at
   * the system's cap, as Unity's does, and this counts births, not the cap.
   */
  const stage1 = BOOST[0]
  const immortal: ParticleSpec = {
    ...stage1,
    initial: stage1.initial && {
      ...stage1.initial,
      lifetime: { ...stage1.initial.lifetime, mode: 0, scalar: 1000 },
      maxParticles: 1024,
    },
  }
  const fly = (drive: Partial<SpeedLineDrive> | null, seconds = 2, spec: ParticleSpec = stage1) => {
    const f = createParticleField(spec, texture, { capacity: 1024 })
    f.setDrive(drive ? { ...NO_DRIVE, ...drive } : null)
    const e = f.addEmitter()
    e.play()
    for (let i = 0; i < Math.round(seconds * 90); i++) f.update(1 / 90, camera)
    return f
  }

  it('emits nothing at rate 0 and half as many at 0.5', () => {
    expect(fly({ rate: 0 }, 2, immortal).alive).toBe(0)
    const full = fly(null, 2, immortal).alive
    const half = fly({ rate: 0.5 }, 2, immortal).alive
    // Two seconds of the authored rate, give or take the carry's last fraction.
    expect(Math.abs(full - 2 * (AUTHORED_RATE[0] as number))).toBeLessThanOrEqual(1)
    expect(Math.abs(half - full / 2)).toBeLessThanOrEqual(1)
  })

  it('scales the spawn speed exactly, and the drawn streak shortens with it', () => {
    // Same seed, same draws, so the first particle is the same particle with
    // half the velocity — and `iParams.z`, the stretch, is computed from it.
    const a = fly(null, 0.1)
    const b = fly({ speed: 0.5 }, 0.1)
    const vel = (f: ParticleField) =>
      ((f.object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).getAttribute('iVelocity')
        .array as Float32Array
    const par = (f: ParticleField) =>
      ((f.object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).getAttribute('iParams')
        .array as Float32Array
    expect(a.alive).toBeGreaterThan(0)
    for (let k = 0; k < 3; k++) {
      expect(vel(b)[k]).toBeCloseTo((vel(a)[k] as number) * 0.5, 4)
    }
    expect(par(b)[2]).toBeLessThan(par(a)[2] as number)
  })

  it('multiplies the alpha into the override’s, and copies rather than holds the drive', () => {
    const f = createParticleField(BOOST[0], texture, {
      capacity: 16,
      override: { alphaScale: 1.3 },
    })
    const mine = { rate: 1, alpha: 0.5, speed: 1 }
    f.setDrive(mine)
    const u = ((f.object as THREE.Mesh).material as THREE.ShaderMaterial).uniforms
    expect(u.uAlphaScale?.value).toBeCloseTo(0.65, 9)
    mine.alpha = 0 // trap 19: a caller's scratch must not reach the field
    expect(f.drive.alpha).toBe(0.5)
    f.setOverride({ alphaScale: 2 })
    expect(u.uAlphaScale?.value).toBeCloseTo(1, 9)
    f.setDrive(null)
    expect(u.uAlphaScale?.value).toBe(2)
  })
})

describe('the speed floor’s rationale, integrated rather than asserted', () => {
  // anniversary.json's note says that at `speedFloor` about half of stage 1's
  // streaks still reach the eye before they die, against about 72 % at the
  // authored speed. A derived number in a note needs a test (CLAUDE.md,
  // DEV-027), so here it is, off the sheet: the emitter's forward offset
  // composed through its ancestors, the first-person camera's, and the
  // mode-3 speed and lifetime ranges, on a fine grid.
  const reachFraction = (speedScale: number): number => {
    const s = BOOST[0]
    // Unity-forward offsets. The camera's is stored in THREE space, whose z is
    // Unity's negated — a 1.27 m term against 100 m, so the sign is not the
    // result, but it is taken the right way round.
    const emitterForward =
      (s.position[2] as number) + s.ancestors.reduce((z, a) => z + (a.position[2] as number), 0)
    const eyeForward = -HOVERJET.camera.firstPerson.positionInShipRootSpace.z
    const distance = emitterForward - eyeForward
    const speed = s.initial?.speed as MinMaxCurveLike
    const life = s.initial?.lifetime as MinMaxCurveLike
    const N = 400
    let reach = 0
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const v = evaluateMinMax(speed, 0, (i + 0.5) / N) * speedScale
        const t = evaluateMinMax(life, 0, (j + 0.5) / N)
        if (v * t >= distance) reach++
      }
    }
    return reach / (N * N)
  }

  it('is about half at the floor and about 72 % at the authored speed', () => {
    const atFloor = reachFraction(ANNIVERSARY.speedFloor)
    const authored = reachFraction(1)
    expect(atFloor).toBeGreaterThan(0.45)
    expect(atFloor).toBeLessThan(0.55)
    expect(authored).toBeGreaterThan(0.69)
    expect(authored).toBeLessThan(0.75)
  })
})
