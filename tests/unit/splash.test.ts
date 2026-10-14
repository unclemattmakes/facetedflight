// tests/unit/splash.test.ts: a splash where anything crosses the sea. DEV-613.
//
// Matt, 2026-10-03: *"can you spawn a "splash" particle fx when anything goes
// in or out of the water? i'm thinking i'd see it the most w/ dolphins land in
// the water, and if jets crash into the water"*.
//
// Each question is asked of something the splash code did not make:
//
//  - HOW BIG: the engine's per-emitter scale against the particles it spawns
//    (sizes, speeds and lifetimes read back off the pool), and inert at 1 to
//    the bit against a field nobody scaled;
//  - WHICH WAY: up and out of the water, against the sheet's world gravity;
//  - WHEN, for a dolphin: the leaper field's own frames, one splash where each
//    leap leaves the water and one where it lands, on the drawn sea;
//  - WHEN, for a jet: the crossing rule against contact sequences, a skim, a
//    bounce and a crash reset among them;
//  - HOW MANY: the real `loadParticleFx`, a pod's worth of splashes in one
//    frame, against the pool's capacity;
//  - WHERE IT IS ON: Anniversary only, a look (D35).

import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edition, EditionSplash } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import { editionKeyClass } from '@/content/edition-split'
import type { Level } from '@/content/level-schema'
import { loadParticleFx, splashCrownSpec, splashDropsSpec, splashScale } from '@/game/particle-fx'
import { createCraftSplash, stepCraftSplash } from '@/game/splash-crossing'
import { WORLD } from '@/generated/constants.generated'
import { createLeaperField, type LeapSplash } from '@/render/life-leapers'
import { createParticleField, particleAttribute } from '@/render/particles'
import type { WaterDisplace } from '@/render/water'
import { airTime, type Leaper } from '@/sim/life/pods'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition
const SHIPPED: EditionSplash = ANNIVERSARY.fx.splash
const TEXTURE = new THREE.Texture()

/** Every live particle's centre, size and velocity, off the field's own instance buffers. */
const readPool = (field: ReturnType<typeof createParticleField>) => {
  const mesh = field.object as THREE.Mesh
  const g = mesh.geometry as THREE.InstancedBufferGeometry
  const pos = particleAttribute(field, 'iPosition').array as Float32Array
  const par = particleAttribute(field, 'iParams').array as Float32Array
  const vel = particleAttribute(field, 'iVelocity').array as Float32Array
  const out: { p: THREE.Vector3; size: number; v: THREE.Vector3 }[] = []
  for (let i = 0; i < g.instanceCount; i++) {
    out.push({
      p: new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]),
      size: par[i * 3] as number,
      v: new THREE.Vector3(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]),
    })
  }
  return out
}

const camera = new THREE.PerspectiveCamera()
/** Up at the water: the pose `splash()` gives an emitter (a +90 degree turn about x). */
const UP = new THREE.Matrix4().makeRotationX(Math.PI / 2)

describe('DEV-613: how big, by the emitter, and inert at 1', () => {
  // Gravity and drag off on a copy, so a reading is the spawn and not the fall.
  const still = { ...SHIPPED, gravity: 0, drag: 0 }

  it('scale 1 is the field nobody scaled, to the bit', () => {
    const a = createParticleField(splashCrownSpec(SHIPPED), TEXTURE, { look: 'paper' })
    const b = createParticleField(splashCrownSpec(SHIPPED), TEXTURE, { look: 'paper' })
    const ea = a.addEmitter()
    const eb = b.addEmitter()
    ea.matrix.copy(UP)
    eb.matrix.copy(UP)
    eb.scale = 1
    ea.play()
    eb.play()
    for (let i = 0; i < 6; i++) {
      a.update(0.0122, camera)
      b.update(0.0122, camera)
    }
    for (const name of ['iPosition', 'iParams', 'iVelocity', 'iColor'] as const) {
      expect(Array.from(particleAttribute(b, name).array), name).toEqual(
        Array.from(particleAttribute(a, name).array),
      )
    }
  })

  it('scale k: sizes and the spread k times, speeds and lifetimes sqrt(k) times, off the pool', () => {
    const k = 4
    // Size over life off on this copy too, so the size read is the spawn's.
    const spec = { ...splashCrownSpec(still), sizeOverLifetime: null }
    const build = (scale: number) => {
      const f = createParticleField(spec, TEXTURE, { look: 'paper' })
      const e = f.addEmitter()
      e.matrix.copy(UP)
      e.scale = scale
      e.play()
      // One tiny step: the burst spawns, and has barely moved.
      f.update(1e-6, camera)
      return f
    }
    const fOne = build(1)
    const fBig = build(k)
    const one = readPool(fOne)
    const big = readPool(fBig)
    expect(big.length).toBe(one.length)
    expect(big.length).toBe(SHIPPED.crown.count)
    for (let i = 0; i < one.length; i++) {
      const a = one[i] as (typeof one)[number]
      const b = big[i] as (typeof big)[number]
      // Same random stream, so particle i is the same draw, scaled.
      expect(b.p.length() / a.p.length()).toBeCloseTo(k, 4)
      expect(b.v.length() / a.v.length()).toBeCloseTo(Math.sqrt(k), 4)
      expect(b.size / a.size).toBeCloseTo(k, 6)
    }
    // Lifetimes: past the longest scale-1 life every scale-1 piece is gone,
    // and the scale-k pieces live on, until sqrt(k) times it.
    const life = SHIPPED.crown.lifetime
    fOne.update(life + 0.01, camera)
    fBig.update(life + 0.01, camera)
    expect(fOne.alive).toBe(0)
    expect(fBig.alive).toBeGreaterThan(0)
    fBig.update(life * (Math.sqrt(k) - 1) + 0.01, camera)
    expect(fBig.alive).toBe(0)
  })

  it('a non-finite or non-positive scale is 1, never a NaN splash', () => {
    const f = createParticleField(splashCrownSpec(SHIPPED), TEXTURE, { look: 'paper' })
    const e = f.addEmitter()
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
      e.scale = bad
      expect(e.scale, String(bad)).toBe(1)
    }
  })
})

describe('DEV-613: which way, against the sheet', () => {
  // The sheet's world gravity, not a direction this file believes in.
  const g = WORLD.gravity
  const down = new THREE.Vector3(g.x, g.y, g.z).normalize()

  for (const [name, spec] of [
    ['crown', splashCrownSpec],
    ['drops', splashDropsSpec],
  ] as const) {
    it(`${name}: every piece leaves UP, against the world's gravity, within its cone`, () => {
      const f = createParticleField(spec({ ...SHIPPED, gravity: 0, drag: 0 }), TEXTURE, {
        look: 'paper',
      })
      const e = f.addEmitter()
      e.matrix.copy(UP)
      e.play()
      f.update(1e-6, camera)
      const pool = readPool(f)
      expect(pool.length).toBeGreaterThan(0)
      const angle = SHIPPED[name].angleDeg
      for (const p of pool) {
        const up = -p.v.clone().normalize().dot(down)
        expect(up, 'a piece thrown down into the sea').toBeGreaterThan(0)
        expect((Math.acos(Math.min(1, up)) * 180) / Math.PI).toBeLessThanOrEqual(angle + 1e-3)
      }
    })
  }

  it('the crown is a RING: every piece at the rim and the full angle; the drops fill the disc', () => {
    expect(splashCrownSpec(SHIPPED).shape?.type).toBe('coneShell')
    expect(splashDropsSpec(SHIPPED).shape?.type).toBe('cone')
    const f = createParticleField(splashCrownSpec({ ...SHIPPED, gravity: 0, drag: 0 }), TEXTURE, {
      look: 'paper',
    })
    const e = f.addEmitter()
    e.matrix.copy(UP)
    e.play()
    f.update(1e-6, camera)
    for (const p of readPool(f)) {
      expect(Math.hypot(p.p.x, p.p.z)).toBeCloseTo(SHIPPED.crown.radius, 3)
    }
  })
})

describe('DEV-613: splashScale', () => {
  it('a dolphin landing is about scale 1; a jet going in fast is several times it, within the cap', () => {
    // The shipped dolphins' middling leap: 2.75 m high, 8 m long, under 9.81.
    const air = airTime(2.75, 9.81)
    const v = Math.hypot(8 / air, (4 * 2.75) / air)
    const dolphin = splashScale(SHIPPED, SHIPPED.dolphinBody, v)
    expect(dolphin).toBeGreaterThan(0.7)
    expect(dolphin).toBeLessThan(1.5)
    const crash = splashScale(SHIPPED, SHIPPED.jetBody, 150)
    expect(crash / dolphin).toBeGreaterThan(4)
    expect(crash).toBeLessThanOrEqual(SHIPPED.maxScale)
    expect(splashScale(SHIPPED, SHIPPED.jetBody, 10_000)).toBe(SHIPPED.maxScale)
  })

  it('grows with speed and body, never below minScale, and a NaN speed is the smallest', () => {
    const at = (v: number) => splashScale(SHIPPED, 1, v)
    expect(at(20)).toBeGreaterThan(at(10))
    expect(splashScale(SHIPPED, 2, 20)).toBeGreaterThan(at(20))
    expect(at(0)).toBe(SHIPPED.minScale)
    expect(at(Number.NaN)).toBe(SHIPPED.minScale)
  })
})

describe('DEV-613: a dolphin splashes where it leaves the water and where it lands', () => {
  const still: WaterDisplace = {
    live: true,
    direction: 0,
    speed: 0,
    amplitude: 0,
    frequency: 0,
    noise: 0,
  }
  const G = 9.81
  const ONE: Leaper = {
    x: 40,
    z: 10,
    heading: 0.7,
    period: 6,
    phase: 0,
    height: 3,
    length: 8,
    scale: 20,
    pod: 0,
  }
  const sea = (y: number) => ({
    corners: new Float64Array([0, y, 0, 1, y, 0, 0, y, 1]),
    weights: [1, 0, 0] as [number, number, number],
  })

  const run = (step: number, seconds: number) => {
    const seen: LeapSplash[] = []
    const field = createLeaperField(
      'life:test',
      new THREE.BoxGeometry(1, 1, 1),
      [{ leaper: ONE, from: sea(116), to: sea(117) }],
      G,
      still,
      undefined,
      null,
      (s) => seen.push({ ...s }),
    )
    for (let t = 0; t <= seconds; t += step) field.update(t, 0.5)
    field.dispose()
    return seen
  }

  it('one out and one in a leap, at the leap two ends, on the drawn sea, moving the arc way', () => {
    const seen = run(1 / 90, 13)
    // Two periods of 6 s: leaps start at 0 (the first frame primes, so none),
    // 6 and 12; each leaves and lands once, the last still in the air at 13.
    const air = airTime(ONE.height, G)
    expect(13 - 12).toBeLessThan(air)
    expect(seen.map((s) => s.entering)).toEqual([true, false, true, false])
    const out = seen[1] as LeapSplash
    const landed = seen[2] as LeapSplash
    // THREE world: the SIM (x, z) through the z flip, half a length either side.
    const dx = Math.sin(ONE.heading) * (ONE.length / 2)
    const dz = Math.cos(ONE.heading) * (ONE.length / 2)
    expect(out.x).toBeCloseTo(ONE.x - dx, 6)
    expect(out.z).toBeCloseTo(-(ONE.z - dz), 6)
    expect(landed.x).toBeCloseTo(ONE.x + dx, 6)
    expect(landed.z).toBeCloseTo(-(ONE.z + dz), 6)
    // On the drawn sea, bob included: 116 where it leaves, 117 where it lands.
    expect(out.y).toBeCloseTo(116.5, 9)
    expect(landed.y).toBeCloseTo(117.5, 9)
    // Up out of the water, down into it, and along its heading both times.
    expect(out.vy).toBeGreaterThan(0)
    expect(landed.vy).toBeLessThan(0)
    const along = (s: LeapSplash) => s.vx * Math.sin(ONE.heading) - s.vz * Math.cos(ONE.heading)
    expect(along(out)).toBeGreaterThan(0)
    expect(along(landed)).toBeGreaterThan(0)
    expect(landed.speed).toBeCloseTo(Math.hypot(landed.vx, landed.vy, landed.vz), 9)
  })

  it('a clock that jumps primes the field instead of reading the jump as a leap', () => {
    // Updates 3 s apart: every one is a jump, so nothing is ever read.
    expect(run(3, 30)).toEqual([])
  })
})

describe('DEV-613: a jet into the sea and out of it', () => {
  const spec = SHIPPED
  const dt = 0.0121999998
  /** One fixed step of the rule: a body at (x, y, 0) moving 100 m/s along x. */
  const tick = (
    state: ReturnType<typeof createCraftSplash>,
    y: number,
    struck: boolean,
    height: number | null,
    x = 0,
  ) =>
    stepCraftSplash(
      state,
      { position: { x, y, z: 0 }, velocity: { x: 100, y: 0, z: 0 }, struck, height, dt },
      spec,
    )
  /** `n` quiet steps at height `y` over the sea, moving with the body. */
  const coast = (state: ReturnType<typeof createCraftSplash>, n: number, y: number) => {
    const out: (string | null)[] = []
    for (let i = 0; i < n; i++) out.push(tick(state, y, false, y, state.x + 100 * dt))
    return out
  }

  it('IN on the contact over the sea; nothing more while it skims; OUT once it rises', () => {
    const s = createCraftSplash()
    expect(tick(s, 5, false, 5)).toBeNull()
    expect(tick(s, 1, true, 1, 100 * dt)).toBe('in')
    // The skim: contacts beginning again and again, and small rises.
    for (let i = 1; i <= 80; i++) {
      const h = 1 + (i % 3) * 0.5
      expect(tick(s, h, i % 4 === 0, h, s.x + 100 * dt)).toBeNull()
    }
    const up = 1 + spec.exitMetres + 0.1
    expect(tick(s, up, false, up, s.x + 100 * dt)).toBe('out')
  })

  it('a contact over LAND is no splash, and leaves it dry', () => {
    const s = createCraftSplash()
    expect(tick(s, 1, true, null)).toBeNull()
    expect(s.wet).toBe(false)
  })

  it('a crash reset puts it somewhere: dry, and no OUT where it reappears', () => {
    const s = createCraftSplash()
    expect(tick(s, 1, true, 1)).toBe('in')
    // Held where it hit (the hold freezes the body), then put 120 m back up
    // the line, 40 m over the water.
    for (let i = 0; i < 40; i++) expect(tick(s, 1, false, 1)).toBeNull()
    expect(tick(s, 41, false, 41, -120)).toBeNull()
    expect(s.wet).toBe(false)
  })

  it('one splash per craft per minSeconds, whichever way, counted in its own steps', () => {
    const s = createCraftSplash()
    expect(tick(s, 1, true, 1)).toBe('in')
    const up = 1 + spec.exitMetres + 1
    // Straight back out and in again, inside minSeconds: both swallowed.
    expect(tick(s, up, false, up, s.x + 100 * dt)).toBeNull()
    expect(tick(s, 1, true, 1, s.x + 100 * dt)).toBeNull()
    const steps = Math.ceil(spec.minSeconds / dt)
    expect(coast(s, steps, 1).every((e) => e === null)).toBe(true)
    // minSeconds on, the way out is due.
    expect(tick(s, up, false, up, s.x + 100 * dt)).toBe('out')
  })
})

describe('DEV-613: a pod at once cannot flood the frame (the real loadParticleFx)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('the pool holds what it was built with, and a second splash in a frame takes its own pair', async () => {
    vi.stubEnv('VITE_ASSET_BASE_URL', '/')
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(new THREE.Texture())
    const fx = await loadParticleFx(int01 as unknown as Level, { splash: SHIPPED })
    const eye = { x: 0, y: 0, z: 0 }
    const before = fx.splashes
    expect(before).toEqual({
      thrown: 0,
      alive: 0,
      emitters: SHIPPED.emitters,
      capacity: (SHIPPED.crown.count + SHIPPED.drops.count) * SHIPPED.emitters,
      last: null,
    })
    // Two in one frame, then a step: both whole.
    expect(fx.splash({ x: 10, y: 0, z: 0 }, { x: 0, y: -5, z: 0 }, 1, eye)).toBe(true)
    expect(fx.splash({ x: -10, y: 0, z: 0 }, { x: 0, y: -5, z: 0 }, 1, eye)).toBe(true)
    fx.update(0.0122, camera)
    expect(fx.splashes?.alive).toBe(2 * (SHIPPED.crown.count + SHIPPED.drops.count))
    // A pod's worth and more, a frame at a time, never past the pool.
    let most = 0
    for (let f = 0; f < 120; f++) {
      for (let k = 0; k < 4; k++) fx.splash({ x: k, y: 0, z: f }, { x: 0, y: -8, z: 0 }, 2, eye)
      fx.update(0.0122, camera)
      most = Math.max(most, fx.splashes?.alive ?? 0)
    }
    expect(most).toBeLessThanOrEqual(fx.splashes?.capacity ?? 0)
    // Past maxMetres from the eye, nothing.
    const far = SHIPPED.maxMetres + 1
    expect(fx.splash({ x: far, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1, eye)).toBe(false)
    fx.dispose()
  })

  it('Classic builds no splash field', async () => {
    vi.stubEnv('VITE_ASSET_BASE_URL', '/')
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockResolvedValue(new THREE.Texture())
    const fx = await loadParticleFx(int01 as unknown as Level, {})
    expect(fx.splashes).toBeNull()
    expect(fx.splash({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1, { x: 0, y: 0, z: 0 })).toBe(
      false,
    )
    fx.dispose()
  })
})

describe('DEV-613: where it is on', () => {
  it('Anniversary throws splashes; Classic throws none (2016 had none)', () => {
    expect(ANNIVERSARY.fx.splash.enabled).toBe(true)
    expect(CLASSIC.fx.splash.enabled).toBe(false)
  })

  it('is a LOOK under D35: Classic-look keeps the rules and loses the splash', () => {
    expect(editionKeyClass('fx.splash')).toBe('look')
  })

  it('the loader refuses a splash that would draw nothing and say nothing', () => {
    const bad = (over: Partial<EditionSplash>) =>
      validateEdition({
        ...ANNIVERSARY,
        fx: { ...ANNIVERSARY.fx, splash: { ...SHIPPED, ...over } },
      })
    expect(() => validateEdition(ANNIVERSARY)).not.toThrow()
    expect(() => bad({ refSpeed: 0 })).toThrow(/refSpeed/)
    expect(() => bad({ emitters: 0 })).toThrow(/emitters/)
    expect(() => bad({ maxScale: 0.1 })).toThrow(/maxScale/)
    expect(() => bad({ crown: { ...SHIPPED.crown, count: 0 } })).toThrow(/crown\.count/)
    expect(() => bad({ drops: { ...SHIPPED.drops, angleDeg: 95 } })).toThrow(/drops/)
  })
})
