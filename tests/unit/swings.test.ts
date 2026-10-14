// DEV-926 / DEV-927: the first swings, the vapour cone and the boost shockwave
// (`docs/plan/GPU-PARTICLES.md` section 5, Matt 2026-10-12: "all plz!").
//
// Geometry against the preset, not the code read back: where a particle is
// born relative to the ship, which way it goes, whether it rides, and when the
// one-shot fires.

import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edition, EditionBoostShockwave, EditionVapourCone } from '@/content/edition-schema'
import { editionKeyClass } from '@/content/edition-split'
import type { Level } from '@/content/level-schema'
import {
  boostShockwaveSpec,
  loadParticleFx,
  vapourConePose,
  vapourConeSpec,
  vapourStrength,
  vortexStrength,
  wingVortexSpec,
} from '@/game/particle-fx'
import { createParticleField, particleAttribute, particleSnapshot } from '@/render/particles'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition
const VAPOUR: EditionVapourCone = ANNIVERSARY.fx.vapourCone
const SHOCK: EditionBoostShockwave = ANNIVERSARY.fx.boostShockwave
const camera = new THREE.PerspectiveCamera()

/** A ship somewhere, turned, flying along its own -Z. */
const SHIP = new THREE.Matrix4()
  .makeRotationFromEuler(new THREE.Euler(0.2, 1.1, -0.3, 'YXZ'))
  .setPosition(120, 40, -60)
const SHIP_INV = SHIP.clone().invert()

/** Each live particle's position and velocity, in the SHIP's frame. */
const inShipFrame = (field: ReturnType<typeof createParticleField>) => {
  const pa = particleAttribute(field, 'iPosition')
  const va = particleAttribute(field, 'iVelocity')
  const lin = new THREE.Matrix3().setFromMatrix4(SHIP_INV)
  const out: { p: THREE.Vector3; v: THREE.Vector3 }[] = []
  for (let i = 0; i < field.alive; i++) {
    out.push({
      p: new THREE.Vector3(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(SHIP_INV),
      v: new THREE.Vector3(va.getX(i), va.getY(i), va.getZ(i)).applyMatrix3(lin),
    })
  }
  return out
}

describe('DEV-926: the vapour cone', () => {
  it('runs from nothing below minSpeed to all of it at fullSpeed, and the slider scales it', () => {
    expect(vapourStrength(VAPOUR, VAPOUR.minSpeed - 1, 1)).toBe(0)
    expect(vapourStrength(VAPOUR, VAPOUR.fullSpeed + 1, 1)).toBe(1)
    const mid = (VAPOUR.minSpeed + VAPOUR.fullSpeed) / 2
    expect(vapourStrength(VAPOUR, mid, 1)).toBeCloseTo(0.5, 6)
    expect(vapourStrength(VAPOUR, VAPOUR.fullSpeed, 0)).toBe(0)
    expect(vapourStrength(VAPOUR, VAPOUR.fullSpeed, 0.5)).toBeCloseTo(0.5, 6)
    expect(vapourStrength({ ...VAPOUR, enabled: false }, VAPOUR.fullSpeed, 1)).toBe(0)
  })

  it('is born on a ring round the line of flight behind the ship, and streams AFT', () => {
    const field = createParticleField(vapourConeSpec(VAPOUR), new THREE.Texture(), {
      capacity: 500,
    })
    const e = field.addEmitter()
    e.matrix.multiplyMatrices(SHIP, vapourConePose(VAPOUR, new THREE.Matrix4()))
    field.update(0, camera)
    e.play()
    field.update(0.01, camera)
    const ps = inShipFrame(field)
    expect(ps.length).toBeGreaterThan(0)
    for (const { p, v } of ps) {
      // Round the ship's own axis (z), at the ring's radius, a hair past its spawn.
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(VAPOUR.radius * 0.95)
      expect(p.z).toBeGreaterThan(VAPOUR.aftMetres - 0.01)
      // Aft (+Z in the ship's frame) and out, never forward.
      expect(v.z).toBeGreaterThan(0)
      expect(p.x * v.x + p.y * v.y).toBeGreaterThan(0)
    }
    field.dispose()
  })

  it('rides the ship: carried with it, not left behind (DEV-308)', () => {
    const field = createParticleField(vapourConeSpec(VAPOUR), new THREE.Texture(), {
      capacity: 500,
    })
    const e = field.addEmitter()
    const pose = vapourConePose(VAPOUR, new THREE.Matrix4())
    e.matrix.multiplyMatrices(SHIP, pose)
    field.update(0, camera)
    e.play()
    field.update(0.01, camera)
    e.stop()
    const before = inShipFrame(field)
    // The ship flies 40 m on; in its own frame the mist barely moves.
    const moved = SHIP.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -40))
    e.matrix.multiplyMatrices(moved, pose)
    field.update(0.01, camera)
    const pa = particleAttribute(field, 'iPosition')
    const inv = moved.clone().invert()
    for (let i = 0; i < before.length; i++) {
      const now = new THREE.Vector3(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(inv)
      expect(now.distanceTo((before[i] as { p: THREE.Vector3 }).p)).toBeLessThan(1)
    }
    field.dispose()
  })
})

describe('DEV-927: the boost shockwave', () => {
  it('is a ring across the line of flight, flying OUT from it, riding the ship', () => {
    const field = createParticleField(boostShockwaveSpec(SHOCK), new THREE.Texture(), {
      capacity: SHOCK.count,
    })
    const e = field.addEmitter()
    e.matrix.copy(SHIP)
    e.play()
    field.update(0.002, camera)
    const ps = inShipFrame(field)
    expect(ps.length).toBe(SHOCK.count)
    for (const { p, v } of ps) {
      expect(Math.abs(p.z)).toBeLessThan(0.05)
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(SHOCK.radius * 0.99)
      expect(Math.abs(v.z)).toBeLessThan(1e-3)
      expect(p.x * v.x + p.y * v.y).toBeGreaterThan(0)
    }
    // It RIDES: the ship flying 200 m on takes the ring with it.
    const moved = SHIP.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -200))
    e.matrix.copy(moved)
    field.update(0.0005, camera)
    const pa = particleAttribute(field, 'iPosition')
    const back = new THREE.Vector3(pa.getX(0), pa.getY(0), pa.getZ(0)).applyMatrix4(
      moved.clone().invert(),
    )
    expect(Math.abs(back.z)).toBeLessThan(0.1)
    field.dispose()
  })
})

describe('DEV-926 / DEV-927: the real loadParticleFx', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  const build = async (
    vapourCone: EditionVapourCone | null,
    boostShockwave: EditionBoostShockwave | null,
  ) => {
    vi.stubEnv('VITE_ASSET_BASE_URL', '/')
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(new THREE.Texture())
    return loadParticleFx(int01 as unknown as Level, { vapourCone, boostShockwave })
  }

  it('throws a shockwave on boost PRESSED, not held, and not inside the cooldown', async () => {
    const fx = await build(null, SHOCK)
    const fast = SHOCK.minSpeed + 50
    let t = 0
    const step = (boosting: boolean, speed = fast) => {
      t += 0.0122
      fx.updateSwings(SHIP, speed, boosting, 1, t)
      fx.update(0.0122, camera)
    }
    step(false)
    step(true)
    expect(fx.swings.shockwave?.thrown).toBe(1)
    // Held past the cooldown: still one, so it is the PRESS that throws.
    for (let k = 0; k < Math.ceil((SHOCK.cooldownSeconds + 0.5) / 0.0122); k++) step(true)
    expect(fx.swings.shockwave?.thrown).toBe(1)
    // Released and pressed, now past the cooldown: another.
    step(false)
    step(true)
    expect(fx.swings.shockwave?.thrown).toBe(2)
    // Released and pressed again at once, inside the cooldown: nothing.
    step(false)
    step(true)
    expect(fx.swings.shockwave?.thrown).toBe(2)
    // Below minSpeed: none.
    t += SHOCK.cooldownSeconds
    step(false)
    step(true, SHOCK.minSpeed - 1)
    expect(fx.swings.shockwave?.thrown).toBe(2)
    // The comfort slider at 0: none.
    t += SHOCK.cooldownSeconds
    fx.updateSwings(SHIP, fast, false, 0, t)
    fx.updateSwings(SHIP, fast, true, 0, t + 0.01)
    expect(fx.swings.shockwave?.thrown).toBe(2)
    expect(fx.swings.vapour).toBeNull()
    fx.dispose()
  })

  it('runs the vapour cone only near top speed', async () => {
    const fx = await build(VAPOUR, null)
    for (let k = 0; k < 30; k++) {
      fx.updateSwings(SHIP, VAPOUR.minSpeed - 10, false, 1, k * 0.0122)
      fx.update(0.0122, camera)
    }
    expect(fx.swings.vapour?.alive).toBe(0)
    for (let k = 0; k < 30; k++) {
      fx.updateSwings(SHIP, VAPOUR.fullSpeed, false, 1, k * 0.0122)
      fx.update(0.0122, camera)
    }
    expect(fx.swings.vapour?.strength).toBe(1)
    expect(fx.swings.vapour?.alive).toBeGreaterThan(0)
    expect(fx.swings.shockwave).toBeNull()
    fx.dispose()
  })
})

describe('DEV-926 / DEV-927: where they are on', () => {
  it('Anniversary draws both; Classic neither (2016 drew neither), and both are looks', () => {
    expect(ANNIVERSARY.fx.vapourCone.enabled).toBe(true)
    expect(ANNIVERSARY.fx.boostShockwave.enabled).toBe(true)
    expect(CLASSIC.fx.vapourCone.enabled).toBe(false)
    expect(CLASSIC.fx.boostShockwave.enabled).toBe(false)
    expect(editionKeyClass('fx.vapourCone')).toBe('look')
    expect(editionKeyClass('fx.boostShockwave')).toBe('look')
  })
})

describe('DEV-928: the wing-tip vortices', () => {
  const VORTEX = ANNIVERSARY.fx.wingVortices

  it('needs speed AND a hard turn, and the slider scales it', () => {
    const fast = VORTEX.fullSpeed + 1
    const hard = VORTEX.fullTurnDeg + 1
    expect(vortexStrength(VORTEX, fast, hard, 1)).toBe(1)
    expect(vortexStrength(VORTEX, VORTEX.minSpeed - 1, hard, 1)).toBe(0)
    expect(vortexStrength(VORTEX, fast, VORTEX.minTurnDeg - 1, 1)).toBe(0)
    expect(vortexStrength(VORTEX, fast, hard, 0)).toBe(0)
    expect(vortexStrength(VORTEX, fast, hard, 0.5)).toBeCloseTo(0.5, 6)
  })

  it('spirals round the line each tip flew, hanging there, the two tips spinning opposite ways', () => {
    const field = createParticleField(wingVortexSpec(VORTEX), new THREE.Texture(), {
      capacity: 2000,
    })
    const port = field.addEmitter()
    const star = field.addEmitter()
    // Two tips 10 m apart, the ship's forward along world -Z; static, so each
    // puff's line is the emitter's own z axis through its tip.
    port.matrix.makeTranslation(-5, 2, 0)
    star.matrix.makeTranslation(5, 2, 0)
    field.update(0, camera)
    port.play()
    star.play()
    for (let k = 0; k < 20; k++) field.update(0.02, camera)
    const snap = particleSnapshot(field)
    expect(snap.count).toBeGreaterThan(20)
    const spins = { port: new Set<number>(), star: new Set<number>() }
    for (let i = 0; i < snap.count; i++) {
      const p = new THREE.Vector3().fromArray(snap.position, i * 3)
      const v = new THREE.Vector3().fromArray(snap.velocity, i * 3)
      const side = p.x < 0 ? 'port' : 'star'
      const offset = p.clone().sub(new THREE.Vector3(side === 'port' ? -5 : 5, 2, 0))
      // On the line: no drift along it.
      expect(Math.abs(offset.z)).toBeLessThan(1e-3)
      // Round it: between the radius it starts at and the one it grows to.
      const rad = Math.hypot(offset.x, offset.y)
      expect(rad).toBeGreaterThan(VORTEX.radius * 0.99)
      expect(rad).toBeLessThan(VORTEX.radius * (1 + VORTEX.radiusGrow) * 1.01)
      // Which way it turns: the sign of (offset x velocity) along the axis.
      spins[side].add(Math.sign(offset.x * v.y - offset.y * v.x))
    }
    expect([...spins.port]).toHaveLength(1)
    expect([...spins.star]).toHaveLength(1)
    expect([...spins.port][0]).toBe(-([...spins.star][0] as number))
    field.dispose()
  })

  it('the real loadParticleFx: two tips, only in a hard turn, and nothing without tips', async () => {
    vi.stubEnv('VITE_ASSET_BASE_URL', '/')
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(new THREE.Texture())
    const fx = await loadParticleFx(int01 as unknown as Level, { wingVortices: VORTEX })
    const tips = { port: new THREE.Vector3(-5, 0, 0), starboard: new THREE.Vector3(5, 0, 0) }
    const fast = VORTEX.fullSpeed + 10
    const m = new THREE.Matrix4()
    let t = 0
    // Straight and level: no turn, no vortices.
    for (let k = 0; k < 20; k++) {
      t += 0.0122
      fx.updateSwings(m, fast, false, 1, t, tips)
      fx.update(0.0122, camera)
    }
    expect(fx.swings.vortices?.alive).toBe(0)
    // A hard turn: yaw at twice fullTurnDeg.
    const rate = (VORTEX.fullTurnDeg * 2 * Math.PI) / 180
    for (let k = 0; k < 20; k++) {
      t += 0.0122
      m.makeRotationY(rate * t)
      fx.updateSwings(m, fast, false, 1, t, tips)
      fx.update(0.0122, camera)
    }
    expect(fx.swings.vortices?.turnDeg).toBeCloseTo(VORTEX.fullTurnDeg * 2, 0)
    expect(fx.swings.vortices?.strength).toBe(1)
    expect(fx.swings.vortices?.alive).toBeGreaterThan(0)
    // No tips (a JumpSeat): nothing.
    fx.updateSwings(m, fast, false, 1, t + 0.0122, null)
    expect(fx.swings.vortices?.strength).toBe(0)
    fx.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('is on in Anniversary, off in Classic, and a look', () => {
    expect(ANNIVERSARY.fx.wingVortices.enabled).toBe(true)
    expect(CLASSIC.fx.wingVortices.enabled).toBe(false)
    expect(editionKeyClass('fx.wingVortices')).toBe('look')
  })
})
