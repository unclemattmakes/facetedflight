// DEV-924: the GPU particle engine against the CPU one it replaces.
//
// Same spec, same seed, same emitter, same steps: the two engines draw the
// same `rand()` stream (emission is shared), so with no particle dying the
// k-th particle of each is the same particle, and every value the vertex
// shader is fed (position, velocity, colour, size, rotation, stretch) can be
// compared one to one. The GPU side is read through `evaluateGpuSlot`, the
// shader's prelude in TypeScript.
//
// Not equal to the bit, by design (`docs/plan/GPU-PARTICLES.md` section 6):
// the CPU integrates drag per step and the GPU uses the closed form, and the
// over-life curves are a 128-texel lookup. At a 1 ms step the two should agree
// to the tolerances below; the step is small so the comparison measures the
// engine, not the CPU's frame-rate dependence.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type ExtractedParticle, padBurstSpecs } from '@/game/particle-fx'
import { HOVERJET, PROPS } from '@/generated/constants.generated'
import {
  createParticleField,
  evaluateMinMax,
  type ParticleField,
  readGpuParticles,
  ridesWithEmitter,
} from '@/render/particles'

const LIVE_SPECS: readonly ExtractedParticle[] = [
  ...(PROPS.checkpointRing.particles as unknown as ExtractedParticle[]),
  ...(HOVERJET.particles as unknown as ExtractedParticle[]),
  // DEV-925: the jump pads' burst, the one riding system WITH gravity.
  ...(padBurstSpecs() as unknown as ExtractedParticle[]),
].filter((p) => p.active && p.emits)

const hasGravity = (spec: ExtractedParticle): boolean => (spec.initial?.gravityModifier ?? 0) !== 0

const DT = 0.001
const camera = new THREE.PerspectiveCamera()

/** The shortest life a spec can draw: the window in which nothing dies. */
const minLife = (spec: ExtractedParticle): number =>
  Math.max(
    0.01,
    Math.min(
      evaluateMinMax(spec.initial?.lifetime, 0, 0),
      evaluateMinMax(spec.initial?.lifetime, 0, 1),
    ),
  )

interface Read {
  p: THREE.Vector3
  v: THREE.Vector3
  c: THREE.Vector4
  params: THREE.Vector3
}

const readCpu = (field: ParticleField): Read[] => {
  const g = (field.object as THREE.Mesh).geometry
  const pa = g.getAttribute('iPosition')
  const va = g.getAttribute('iVelocity')
  const ca = g.getAttribute('iColor')
  const qa = g.getAttribute('iParams')
  const out: Read[] = []
  for (let i = 0; i < field.alive; i++) {
    out.push({
      p: new THREE.Vector3(pa.getX(i), pa.getY(i), pa.getZ(i)),
      v: new THREE.Vector3(va.getX(i), va.getY(i), va.getZ(i)),
      c: new THREE.Vector4(ca.getX(i), ca.getY(i), ca.getZ(i), ca.getW(i)),
      params: new THREE.Vector3(qa.getX(i), qa.getY(i), qa.getZ(i)),
    })
  }
  return out
}

/** Run both engines side by side; `pose(t)` moves the emitter (a riding check). */
const runBoth = (
  spec: ExtractedParticle,
  seconds: number,
  pose: (t: number, m: THREE.Matrix4) => void,
) => {
  const fields = (['cpu', 'gpu'] as const).map((engine) => {
    const field = createParticleField(spec, new THREE.Texture(), { capacity: 4000, engine })
    const e = field.addEmitter()
    pose(0, e.matrix)
    // One update to pose it before anything is born (the CPU's first pose is not motion).
    field.update(0, camera)
    e.play()
    return { field, e }
  })
  const steps = Math.floor(seconds / DT)
  for (let k = 1; k <= steps; k++) {
    for (const { field, e } of fields) {
      pose(k * DT, e.matrix)
      field.update(DT, camera)
    }
  }
  const [cpu, gpu] = fields as [(typeof fields)[0], (typeof fields)[0]]
  return { cpu: readCpu(cpu.field), gpu: readGpuParticles(gpu.field) ?? [], fields }
}

interface Worst {
  n: number
  p: number
  v: number
  c: number
  size: number
  rot: number
  stretch: number
}

const compare = (cpu: Read[], gpu: ReturnType<typeof readGpuParticles> & object): Worst => {
  const w: Worst = { n: cpu.length, p: 0, v: 0, c: 0, size: 0, rot: 0, stretch: 0 }
  for (let i = 0; i < cpu.length; i++) {
    const a = cpu[i] as Read
    const b = gpu[i]
    if (!b) continue
    w.p = Math.max(w.p, a.p.distanceTo(b.position) / (1 + a.v.length() * 0.1))
    w.v = Math.max(w.v, a.v.distanceTo(b.velocity) / (1 + a.v.length()))
    w.c = Math.max(w.c, a.c.clone().sub(b.colour).length())
    w.size = Math.max(w.size, Math.abs(a.params.x - b.params.x) / (1e-3 + Math.abs(a.params.x)))
    w.rot = Math.max(w.rot, Math.abs(a.params.y - b.params.y))
    w.stretch = Math.max(
      w.stretch,
      Math.abs(a.params.z - b.params.z) / (1e-3 + Math.abs(a.params.z)),
    )
  }
  return w
}

describe('DEV-924: the GPU engine draws what the CPU engine draws', () => {
  it('for every live 2016 system, an emitter at rest', () => {
    const rows: string[] = []
    let compared = 0
    for (const spec of LIVE_SPECS) {
      const window = Math.min(0.4, minLife(spec) * 0.9)
      const { cpu, gpu } = runBoth(spec, window, (_t, m) =>
        m.makeRotationY(0.7).setPosition(30, 5, -12),
      )
      expect(gpu.length, `${spec.name}: same live count`).toBe(cpu.length)
      if (cpu.length === 0) continue
      compared++
      const w = compare(cpu, gpu)
      rows.push(
        `${spec.name.padEnd(24)} n=${String(w.n).padStart(4)} p=${w.p.toExponential(2)} v=${w.v.toExponential(2)} c=${w.c.toExponential(2)} size=${w.size.toExponential(2)} rot=${w.rot.toExponential(2)} stretch=${w.stretch.toExponential(2)}`,
      )
      expect(w.p, `${spec.name} position`).toBeLessThan(5e-3)
      expect(w.v, `${spec.name} velocity`).toBeLessThan(5e-3)
      expect(w.c, `${spec.name} colour`).toBeLessThan(1e-2)
      expect(w.size, `${spec.name} size`).toBeLessThan(5e-3)
      expect(w.rot, `${spec.name} rotation`).toBeLessThan(1e-2)
      expect(w.stretch, `${spec.name} stretch`).toBeLessThan(1e-2)
    }
    console.info(`\n${rows.join('\n')}`)
    expect(compared).toBeGreaterThan(5)
  })

  it('for every riding system, an emitter that swings and travels (DEV-308)', () => {
    let compared = 0
    for (const spec of LIVE_SPECS.filter(ridesWithEmitter)) {
      const window = Math.min(0.4, minLife(spec) * 0.9)
      // A system with gravity TRAVELS but does not turn: gravity is added in
      // world space, exact for an emitter that does not rotate (the pads), and
      // the CPU engine would rotate the fallen distance with a turning one.
      const turn = hasGravity(spec) ? 0 : 2
      const { cpu, gpu } = runBoth(spec, window, (t, m) =>
        m.makeRotationY(0.7 + turn * t).setPosition(30 + 80 * t, 5 + 10 * t, -12),
      )
      expect(gpu.length, `${spec.name}: same live count`).toBe(cpu.length)
      if (cpu.length === 0) continue
      compared++
      const w = compare(cpu, gpu)
      expect(w.p, `${spec.name} position`).toBeLessThan(5e-3)
      expect(w.v, `${spec.name} velocity`).toBeLessThan(5e-3)
    }
    expect(compared).toBeGreaterThan(5)
  })

  it('an idle field draws nothing and uploads nothing', () => {
    const spec = LIVE_SPECS[0] as ExtractedParticle
    const field = createParticleField(spec, new THREE.Texture(), { capacity: 500, engine: 'gpu' })
    for (let k = 0; k < 10; k++) field.update(0.02, camera)
    const g = (field.object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry
    expect(field.alive).toBe(0)
    expect(g.instanceCount).toBe(0)
    expect((g.getAttribute('aSpawnPos') as THREE.BufferAttribute).version).toBe(0)
  })
})
