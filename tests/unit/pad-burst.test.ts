// tests/unit/pad-burst.test.ts — the jump pad's landing burst (DEV-415).
//
// 2016's `Trigger_JumpTarget.OnTriggerEnter` plays `jumpPad_fx` when the seat
// scores a plate, and Unity's `Play()` takes the system's children with it. The
// orientation is tested as GEOMETRY: the burst's spawn rings must lie FLAT
// around the pad. A cone on the wrong axis stands them on edge, which a
// quaternion assertion would only restate.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { emitterLocalMatrix, padBurstSpecs } from '@/game/particle-fx'
import { livePads } from '@/game/targets'
import { PROPS } from '@/generated/constants.generated'
import { createParticleField, type ParticleSpec, particleAttribute } from '@/render/particles'
import rookie01 from '../../content/levels/rookie_01_jumpSeat.json'

const SHEET = PROPS.jumpPad as unknown as {
  readonly scoringTriggers: number
  readonly burstFileId: string | null
}

/** Spawn positions in the pad's own frame, after running `seconds` in small steps. */
const spawned = (spec: ParticleSpec, local: THREE.Matrix4, seconds: number): THREE.Vector3[] => {
  const field = createParticleField(spec, new THREE.Texture(), { capacity: 4096 })
  const e = field.addEmitter()
  e.matrix.copy(local)
  e.play()
  const camera = new THREE.PerspectiveCamera()
  // Up to the burst in one step, then a sliver past it, so what is alive sits
  // within centimetres of where it was born.
  if (seconds > 0) field.update(seconds, camera)
  field.update(1e-4, camera)
  const attr = particleAttribute(field, 'iPosition')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < field.alive; i++)
    out.push(new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i)))
  field.dispose()
  return out
}

describe('the pad burst, off the sheet', () => {
  it('is one system named by all 17 scoring plates', () => {
    expect(SHEET.scoringTriggers).toBe(17)
    expect(SHEET.burstFileId).not.toBeNull()
  })

  it('fires the burst and its two children, burst first', () => {
    const specs = padBurstSpecs()
    expect(specs.map((s) => s.name)).toEqual(['jumpPad_fx', 'jumpPad_fx (1)', 'jumpPad_fx (2)'])
    expect(specs[0]?.fileId).toBe(SHEET.burstFileId)
    for (const child of specs.slice(1))
      expect(child.ancestors.map((a) => a.name)).toContain('jumpPad_fx')
  })

  it("is Local scaling on all three, which is why the pad's scale is not applied", () => {
    // `loadParticleFx` poses a pad's emitters with a UNIT scale. That rests on
    // this: Unity's `scalingMode` 1 is Local, which ignores a parent's scale.
    for (const s of padBurstSpecs())
      expect((s as unknown as { scalingMode: number }).scalingMode, s.name).toBe(1)
  })
})

describe('the burst rings the pad flat (geometry, not a quaternion)', () => {
  const [lead, , ring] = padBurstSpecs()
  const pad = livePads(rookie01 as unknown as Level)[0]
  if (!lead || !ring || !pad) throw new Error('no pad burst, or no pad on rookie_01_jumpSeat')
  const landingRadius = pad.landing?.radius ?? 0

  for (const [spec, at] of [
    [lead, 0],
    [ring, 0.1],
  ] as const) {
    it(`${spec.name}: born on a horizontal ring inside the pad's landing radius`, () => {
      const points = spawned(spec, emitterLocalMatrix(spec), at)
      expect(points.length).toBeGreaterThan(200)
      const radius = spec.shape?.radius ?? 0
      const flat = points.filter(
        (p) => Math.abs(p.y) < 1 && Math.abs(Math.hypot(p.x, p.z) - radius) < 1,
      )
      // A few rate-emitted particles from the stretch before a late burst have
      // moved; the burst itself has not.
      expect(flat.length / points.length).toBeGreaterThan(0.95)
      // And the ring is ON the pad: inside the capsule that says you landed.
      expect(radius).toBeGreaterThan(0)
      expect(radius).toBeLessThan(landingRadius)
    })
  }

  it('would stand on edge if the cone were not turned up, so the test can fail', () => {
    // The same spawn with the burst's own −90° about x taken away.
    const upright = { ...lead, rotation: [0, 0, 0, 1] } as typeof lead
    const points = spawned(upright, emitterLocalMatrix(upright), 0)
    const ySpread = Math.max(...points.map((p) => Math.abs(p.y)))
    expect(ySpread).toBeGreaterThan(10)
  })
})

describe('each pad caps its OWN burst at maxParticles (DEV-417)', () => {
  // One field draws every pad's copy of a system. Its pool is the FIELD's
  // allocation; Unity's cap is per system, which here is per emitter. The pool
  // below is 8x the cap so that only the per-emitter rule can stop a burst.
  const ring = padBurstSpecs()[2] as NonNullable<ReturnType<typeof padBurstSpecs>[number]>
  const cap = ring.initial?.maxParticles ?? 0
  const camera = new THREE.PerspectiveCamera()

  /** The most particles alive at once over three seconds. */
  const peakOf = (emitters: number) => {
    const field = createParticleField(ring, new THREE.Texture(), { capacity: cap * 8 })
    const all = Array.from({ length: emitters }, () => field.addEmitter())
    for (const e of all) e.play()
    let peak = 0
    for (let k = 0; k < 300; k++) {
      field.update(0.01, camera)
      peak = Math.max(peak, field.alive)
    }
    return { field, peak, first: all[0] as NonNullable<(typeof all)[number]> }
  }

  it('bursts past its cap on paper, so the cap is doing the work', () => {
    expect(ring.emission?.bursts.some((x) => x.max > cap)).toBe(true)
  })

  it('stops one emitter at the cap, with room in the pool', () => {
    // Without the rule this system's seeded burst peaks at 539.
    const { field, peak } = peakOf(1)
    expect(peak).toBeLessThanOrEqual(cap)
    field.dispose()
  })

  it('caps each emitter, not the field: two together pass one cap', () => {
    const { field, peak } = peakOf(2)
    expect(peak).toBeGreaterThan(cap)
    expect(peak).toBeLessThanOrEqual(cap * 2)
    field.dispose()
  })

  it('gives the slots back as particles die, so a later burst is whole', () => {
    const { field, first } = peakOf(1)
    expect(field.alive).toBe(0)
    first.play()
    for (let k = 0; k < 12; k++) field.update(0.01, camera)
    expect(field.alive).toBeGreaterThan(cap * 0.5)
    field.dispose()
  })
})
