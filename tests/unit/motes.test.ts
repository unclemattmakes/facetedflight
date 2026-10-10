// tests/unit/motes.test.ts — the near-field air: where a mote goes, when it is
// recycled, how many there are, and that Classic has none.
//
// **What this file can claim.** The geometry and the arithmetic. A mote spawns
// inside the shell and ahead of the velocity; a passed one is recycled and a
// new one is born where the fade has already hidden it; the pool is the preset
// times the comfort slider; the same seed twice is the same field twice; and
// the field is built around the camera's WORLD position rather than the head
// pose inside the XR rig (trap 18, which has cost this port two days once
// already).
//
// **What it cannot claim.** That 1,400 motes at 0.5 alpha is the right number,
// or a tolerable one. ANNIVERSARY.md §2.6 is explicit that everything which
// creates a sense of speed creates vection, and king-tide's own note — quoted
// in §6 — is that its readability overlays shipped at full strength, read as
// "allover noise", and were dialled to zero and then removed. *Authored at the
// strength that demos well is too strong for a lap.* That is settled in a
// headset, on a full lap, by a person; every number here is a knob in
// `content/editions/anniversary.json` so that settling it costs no code.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createAir, moteSpecFor } from '@/game/air'
import { createEditionState } from '@/game/edition'
import {
  BEHIND_MARGIN,
  createMoteField,
  fadeOutAt,
  isPassed,
  MOTE_VERTEX_SHADER,
  type MoteSpec,
  moteAlpha,
  moteCorner,
  moteLength,
  respawnRadii,
  SPAWN_BAND,
  spawnOffset,
} from '@/render/motes'
import { makeRandom } from '@/sim/terrain/faceted'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const ANNIVERSARY = anniversary as unknown as Edition
const CLASSIC = classic as unknown as Edition

const spec = (over: Partial<MoteSpec> = {}): MoteSpec => ({
  ...(moteSpecFor(ANNIVERSARY, 1) as MoteSpec),
  ...over,
})

const FORWARD = { x: 0, y: 0, z: -1 }

/** A camera whose world position is not its local one — the cockpit's shape. */
const riggedCamera = (rig: [number, number, number]): THREE.Camera => {
  const camera = new THREE.PerspectiveCamera()
  const parent = new THREE.Object3D()
  parent.position.set(...rig)
  parent.add(camera)
  return camera
}

/** The pool's world positions, straight off the instanced attribute. */
const positionsOf = (object: THREE.Object3D): Float32Array => {
  const g = (object as THREE.Mesh).geometry as THREE.BufferGeometry
  return (g.getAttribute('iPosition') as THREE.BufferAttribute).array as Float32Array
}

const instanceCount = (object: THREE.Object3D): number =>
  ((object as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount

describe('where a mote goes', () => {
  it('lands inside the shell and never behind the velocity', () => {
    const rand = makeRandom(11)
    const s = spec()
    const out = new THREE.Vector3()
    for (let i = 0; i < 2000; i++) {
      spawnOffset(rand, s, FORWARD, s.innerRadius, s.outerRadius, out)
      const r = out.length()
      expect(r).toBeGreaterThanOrEqual(s.innerRadius - 1e-6)
      expect(r).toBeLessThanOrEqual(s.outerRadius + 1e-6)
      // A mote born behind you is a mote that respawns on the next frame, and
      // on every frame after it. The spawn cone is the forward hemisphere.
      expect(out.z).toBeLessThanOrEqual(1e-6)
    }
  })

  it('is never inside the cockpit, which is the VR half of the rule', () => {
    // The canopy is 1-2 m out. `innerRadius` is the only thing between the
    // preset and a mote hanging inside the glass, where it is not air but a
    // fault — and it is a preset key precisely so that a headset session can
    // move it without a build.
    const s = spec()
    expect(s.innerRadius).toBeGreaterThanOrEqual(3)
  })

  it('leans toward the velocity axis, and `aheadBias` is what leans it', () => {
    const mean = (bias: number): number => {
      const rand = makeRandom(7)
      const out = new THREE.Vector3()
      const s = spec({ aheadBias: bias })
      let total = 0
      for (let i = 0; i < 3000; i++) {
        spawnOffset(rand, s, FORWARD, s.innerRadius, s.outerRadius, out)
        total += -out.z / out.length()
      }
      return total / 3000
    }
    // 0 is a uniform hemisphere, whose mean cosine is 1/2 exactly.
    expect(mean(0)).toBeCloseTo(0.5, 1)
    expect(mean(0.8)).toBeGreaterThan(mean(0))
    expect(mean(1)).toBeGreaterThan(mean(0.8))
  })

  it('packs by OCTAVE of distance, so the near field is not empty', () => {
    // Uniform-in-volume would put the median of a 3.5-55 m shell at 44 m —
    // the far field the game already has too much of (ANNIVERSARY §2.1). A
    // log-uniform radius puts the median at the geometric mean instead.
    const rand = makeRandom(3)
    const s = spec()
    const out = new THREE.Vector3()
    const radii: number[] = []
    for (let i = 0; i < 4000; i++) {
      spawnOffset(rand, s, FORWARD, s.innerRadius, s.outerRadius, out)
      radii.push(out.length())
    }
    radii.sort((a, b) => a - b)
    const median = radii[Math.floor(radii.length / 2)] as number
    expect(median).toBeCloseTo(Math.sqrt(s.innerRadius * s.outerRadius), 0)
    expect(median).toBeLessThan(s.outerRadius / 3)
  })
})

describe('when a mote is recycled', () => {
  const s = spec()

  it('keeps one that is ahead, or abeam within the margin', () => {
    expect(isPassed({ x: 0, y: 0, z: -20 }, FORWARD, s.outerRadius)).toBe(false)
    expect(isPassed({ x: 12, y: 0, z: 0 }, FORWARD, s.outerRadius)).toBe(false)
    // Just behind, inside the margin: kept, because a mote sitting exactly
    // abeam must not flip state on alternate frames.
    expect(isPassed({ x: 5, y: 0, z: BEHIND_MARGIN * 0.5 }, FORWARD, s.outerRadius)).toBe(false)
  })

  it('recycles one that is behind, or out of the shell', () => {
    expect(isPassed({ x: 0, y: 0, z: BEHIND_MARGIN + 0.1 }, FORWARD, s.outerRadius)).toBe(true)
    expect(isPassed({ x: 0, y: 0, z: -(s.outerRadius + 1) }, FORWARD, s.outerRadius)).toBe(true)
  })

  it('is born at almost no alpha, which is the property that matters', () => {
    // The relationship, not the value (trap 24). What makes a respawn invisible
    // is not its radius but the ALPHA the far fade gives it there, and a test
    // that asserted the radius would go on passing if the fade band moved.
    // Spawn across the whole shell instead and half the pool appears at full
    // alpha inside 15 m: hundreds of specks a second popping into the part of
    // the frame the eye is best at.
    const rand = makeRandom(5)
    const out = new THREE.Vector3()
    const [lo, hi] = respawnRadii(s)
    let worst = 0
    for (let i = 0; i < 500; i++) {
      spawnOffset(rand, s, FORWARD, lo, hi, out)
      worst = Math.max(worst, fadeOutAt(out.length(), s.outerRadius))
    }
    expect(worst).toBeLessThan(0.1)
  })

  it('fades all the way in by the time a mote is anywhere near you', () => {
    // The other end of the same relationship: born at nothing, full by the time
    // it is close enough to read as the roadside.
    expect(fadeOutAt(s.outerRadius, s.outerRadius)).toBe(0)
    expect(fadeOutAt(s.outerRadius * (1 - SPAWN_BAND), s.outerRadius)).toBe(1)
    expect(fadeOutAt(s.outerRadius / 2, s.outerRadius)).toBe(1)
  })
})

describe('how a mote is drawn', () => {
  it('is a speck at 40 m/s and a short streak at 180', () => {
    const s = spec()
    const slow = moteLength(s, 40)
    const fast = moteLength(s, 180)
    expect(slow).toBeCloseTo(s.size + s.stretchSeconds * 40, 6)
    expect(fast).toBeCloseTo(s.size + s.stretchSeconds * 180, 6)
    expect(slow).toBeLessThan(0.4)
    expect(fast).toBeGreaterThan(3 * slow)
    // Never shorter than the mote itself, whatever the speed.
    expect(moteLength(s, 0)).toBe(s.size)
  })

  it('fades in over the speed range and draws nothing below it', () => {
    const s = spec()
    expect(moteAlpha(s, s.minSpeed - 1)).toBe(0)
    expect(moteAlpha(s, s.minSpeed)).toBe(0)
    expect(moteAlpha(s, (s.minSpeed + s.fullSpeed) / 2)).toBeCloseTo(s.alpha / 2, 6)
    expect(moteAlpha(s, s.fullSpeed)).toBeCloseTo(s.alpha, 6)
    // Above the top of the ramp it holds, rather than climbing to a whiteout.
    expect(moteAlpha(s, 437.5)).toBeCloseTo(s.alpha, 6)
  })

  it('does not read 2016 threshold as its own', () => {
    // `minSpeed` is deliberately NOT the 25 m/s that gates `flight_particles`.
    // That number is generated, it belongs to the shipped systems, and a preset
    // that copied it would be hand-typing an extracted constant into content
    // (hard rule 3).
    expect(spec().minSpeed).not.toBe(25)
  })
})

describe('the preset and the comfort slider', () => {
  it('draws nothing at all on Classic', () => {
    expect(moteSpecFor(CLASSIC, 1)).toBeNull()
    expect(moteSpecFor(CLASSIC, 0.5)).toBeNull()
    expect(moteSpecFor(CLASSIC, 0)).toBeNull()
  })

  it('draws nothing with the speed effects off, on either preset', () => {
    expect(moteSpecFor(ANNIVERSARY, 0)).toBeNull()
  })

  it('halves the pool AND the alpha at light — a quarter of the moving pixels', () => {
    const full = moteSpecFor(ANNIVERSARY, 1) as MoteSpec
    const light = moteSpecFor(ANNIVERSARY, 0.5) as MoteSpec
    expect(light.count).toBe(Math.floor(full.count / 2))
    expect(light.alpha).toBeCloseTo(full.alpha / 2, 6)
    // The shell is the same shell: the slider changes how much is moving, not
    // where the air is.
    expect(light.innerRadius).toBe(full.innerRadius)
    expect(light.outerRadius).toBe(full.outerRadius)
  })

  it('stays inside the budget at full', () => {
    // One draw call either way, but ANNIVERSARY §5 priced this at about 2,000
    // instances and nobody has measured a Quest yet.
    expect((moteSpecFor(ANNIVERSARY, 1) as MoteSpec).count).toBeLessThanOrEqual(2000)
  })
})

describe('the field, as it runs', () => {
  const fly = (
    field: ReturnType<typeof createMoteField>,
    camera: THREE.Camera,
    steps: number,
    step = 2,
  ): void => {
    for (let i = 0; i < steps; i++) {
      camera.position.z -= step
      field.update(camera, { x: 0, y: 0, z: -90 })
    }
  }

  it('builds the field around the camera WORLD position, not the local one', () => {
    // Trap 18. In the cockpit the camera is a child of the XR rig, so
    // `camera.position` is the head pose INSIDE it — the origin until you lean
    // — while the rig carries the altitude. A field built on the local position
    // would sit 4 km away at sea level, and every mote would be behind you.
    const camera = riggedCamera([4000, 300, -1200])
    const field = createMoteField(spec({ count: 64 }))
    field.update(camera, { x: 0, y: 0, z: -90 })
    const p = positionsOf(field.object)
    const s = spec()
    for (let i = 0; i < 64; i++) {
      const d = Math.hypot(
        (p[i * 3] as number) - 4000,
        (p[i * 3 + 1] as number) - 300,
        (p[i * 3 + 2] as number) + 1200,
      )
      expect(d).toBeGreaterThanOrEqual(s.innerRadius - 1e-3)
      expect(d).toBeLessThanOrEqual(s.outerRadius + 1e-3)
    }
    field.dispose()
  })

  it('holds the invariant while you fly: everything drawn is ahead and inside', () => {
    const camera = new THREE.PerspectiveCamera()
    const s = spec({ count: 200 })
    const field = createMoteField(s)
    fly(field, camera, 120)
    const p = positionsOf(field.object)
    camera.updateWorldMatrix(true, false)
    for (let i = 0; i < 200; i++) {
      const dx = (p[i * 3] as number) - camera.position.x
      const dy = (p[i * 3 + 1] as number) - camera.position.y
      const dz = (p[i * 3 + 2] as number) - camera.position.z
      // Forward is -z, so "ahead" is -dz.
      expect(-dz).toBeGreaterThanOrEqual(-BEHIND_MARGIN - 1e-3)
      expect(Math.hypot(dx, dy, dz)).toBeLessThanOrEqual(s.outerRadius + 1e-3)
    }
    field.dispose()
  })

  it('recycles a few slots a frame, not the whole pool', () => {
    // The pattern king-tide's wind-trails is here for: the CPU touches a slot
    // when it respawns and not otherwise. A frame that rewrote every slot would
    // show up as the pool moving wholesale.
    const camera = new THREE.PerspectiveCamera()
    const field = createMoteField(spec({ count: 400 }))
    fly(field, camera, 40)
    const before = Float32Array.from(positionsOf(field.object))
    fly(field, camera, 1)
    const after = positionsOf(field.object)
    let moved = 0
    for (let i = 0; i < 400; i++) {
      if (before[i * 3 + 2] !== after[i * 3 + 2]) moved++
    }
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThan(400 * 0.25)
    field.dispose()
  })

  it('reseeds around the eye after a teleport', () => {
    // A restart, an elevator, a level change. Streaming 1,400 motes home one
    // frame at a time is worse than starting again — king-tide's guard.
    const camera = new THREE.PerspectiveCamera()
    const s = spec({ count: 64 })
    const field = createMoteField(s)
    field.update(camera, { x: 0, y: 0, z: -90 })
    camera.position.set(0, 0, -30_000)
    field.update(camera, { x: 0, y: 0, z: -90 })
    const p = positionsOf(field.object)
    for (let i = 0; i < 64; i++) {
      const d = Math.hypot(
        p[i * 3] as number,
        p[i * 3 + 1] as number,
        (p[i * 3 + 2] as number) + 30_000,
      )
      expect(d).toBeLessThanOrEqual(s.outerRadius + 1e-3)
    }
    field.dispose()
  })

  it('draws nothing before the first update, on either preset', () => {
    // `InstancedBufferGeometry.instanceCount` defaults to INFINITY, and this
    // object is in the scene from boot: every title-screen frame renders it
    // before a flight exists to update it.
    for (const s of [null, spec({ count: 64 })]) {
      const field = createMoteField(s)
      expect(field.active).toBe(0)
      expect(field.object.visible).toBe(false)
      field.dispose()
    }
  })

  it('draws nothing with no flight, and nothing below the speed floor', () => {
    const camera = new THREE.PerspectiveCamera()
    const field = createMoteField(spec({ count: 64 }))
    field.update(camera, null)
    expect(field.active).toBe(0)
    expect(instanceCount(field.object)).toBe(0)
    field.update(camera, { x: 0, y: 0, z: -1 })
    expect(field.active).toBe(0)
    field.update(camera, { x: 0, y: 0, z: -90 })
    expect(field.active).toBe(64)
    field.dispose()
  })

  it('is deterministic: the same seed twice is the same field twice', () => {
    const run = (): Float32Array => {
      const camera = new THREE.PerspectiveCamera()
      const field = createMoteField(spec({ count: 128 }), { seed: 99 })
      fly(field, camera, 30)
      const p = Float32Array.from(positionsOf(field.object))
      field.dispose()
      return p
    }
    expect(Array.from(run())).toEqual(Array.from(run()))
  })

  it('is unmoved by a SECOND field stepping between its frames', () => {
    // Trap 19, the version that applies here: `spawnOffset` works in
    // module-level scratch vectors, and a scratch shared across instances is
    // how a finished AI racer came to fly on another racer's stick. With one
    // field there is nobody to inherit from, so the guard is a second one.
    const alone = (): Float32Array => {
      const camera = new THREE.PerspectiveCamera()
      const field = createMoteField(spec({ count: 96 }), { seed: 4242 })
      for (let i = 0; i < 25; i++) {
        camera.position.z -= 3
        field.update(camera, { x: 0, y: 0, z: -120 })
      }
      const p = Float32Array.from(positionsOf(field.object))
      field.dispose()
      return p
    }
    const interleaved = (): Float32Array => {
      const camera = new THREE.PerspectiveCamera()
      const other = new THREE.PerspectiveCamera()
      other.position.set(900, 80, 40)
      const field = createMoteField(spec({ count: 96 }), { seed: 4242 })
      const second = createMoteField(spec({ count: 64 }), { seed: 777 })
      for (let i = 0; i < 25; i++) {
        camera.position.z -= 3
        other.position.x += 7
        field.update(camera, { x: 0, y: 0, z: -120 })
        second.update(other, { x: 130, y: 0, z: 0 })
      }
      const p = Float32Array.from(positionsOf(field.object))
      field.dispose()
      second.dispose()
      return p
    }
    expect(Array.from(interleaved())).toEqual(Array.from(alone()))
  })
})

describe('createAir, the preset binding', () => {
  const stateFor = (edition: Edition, speedFx: 'off' | 'light' | 'full') =>
    createEditionState(edition, { ...DEFAULT_SETTINGS, speedFx })

  it('draws zero instances on Classic, every frame, forever', () => {
    const camera = new THREE.PerspectiveCamera()
    const air = createAir(stateFor(CLASSIC, 'full'))
    for (let i = 0; i < 10; i++) {
      camera.position.z -= 5
      air.update(camera, { x: 0, y: 0, z: -200 })
      expect(air.active).toBe(0)
    }
    air.dispose()
  })

  it('follows a flip without a reload, both ways', () => {
    const camera = new THREE.PerspectiveCamera()
    const state = stateFor(CLASSIC, 'full')
    const air = createAir(state)
    air.update(camera, { x: 0, y: 0, z: -120 })
    expect(air.active).toBe(0)

    state.setLook(ANNIVERSARY)
    camera.position.z -= 5
    air.update(camera, { x: 0, y: 0, z: -120 })
    expect(air.active).toBe(ANNIVERSARY.fx.motes.count)

    // And the slider, which is a different notification for the same reason.
    state.setSettings({ ...DEFAULT_SETTINGS, speedFx: 'light' })
    camera.position.z -= 5
    air.update(camera, { x: 0, y: 0, z: -120 })
    expect(air.active).toBe(Math.floor(ANNIVERSARY.fx.motes.count / 2))

    state.setSettings({ ...DEFAULT_SETTINGS, speedFx: 'off' })
    camera.position.z -= 5
    air.update(camera, { x: 0, y: 0, z: -120 })
    expect(air.active).toBe(0)
    air.dispose()
  })

  it('stops listening when it is disposed', () => {
    const camera = new THREE.PerspectiveCamera()
    const state = stateFor(CLASSIC, 'full')
    const air = createAir(state)
    air.dispose()
    state.setLook(ANNIVERSARY)
    air.update(camera, { x: 0, y: 0, z: -120 })
    expect(air.active).toBe(0)
  })
})

// ── DEV-318: which way a MOTE is drawn ────────────────────────────────────
//
// This file's own header says what it could claim: *"the geometry and the
// arithmetic"* — where a mote goes, when it is recycled, how many there are.
// A mote's POSITION was covered from the day it was written. The direction it
// is DRAWN in was covered by nothing, and that is where the defect was.
//
// It is the same gap DEV-309 found in the particle suite one file over, and
// the same defect DEV-138 fixed in that file's shader: the streak was built
// from the velocity's 2D SHADOW ON THE SCREEN instead of in three dimensions.
// Because the velocity is a UNIFORM here, that gave all 1,400 motes ONE
// direction and ONE length — parallel equal streaks, which is rain, not optic
// flow — and flying along your own velocity drove the shadow to zero, where it
// snapped to a fixed screen-up fallback.
//
// ── What the assertion is, and why it is not a convention ────────────────
//
// Optic flow has a definition, and it is geometric: for a STATIC field and a
// moving eye, every point's image slides directly away from the FOCUS OF
// EXPANSION — the vanishing point of the velocity. So a mote's streak must lie
// along the line from that point through that mote's own image, and that is
// true whatever anyone believes about handedness, screen axes or three's
// conventions. It is also exactly what the old code could not do, because one
// shared screen direction cannot be radial from a common point at more than
// one place at once.
describe('a mote streaks along the optic flow, not down the screen (DEV-318)', () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000)
  camera.updateProjectionMatrix()

  /** View space to normalised screen, perspective divide included. */
  const project = (v: THREE.Vector3): THREE.Vector2 => {
    const p = v.clone().applyMatrix4(camera.projectionMatrix)
    return new THREE.Vector2(p.x, p.y)
  }

  // Deliberately NOT down the view axis. A velocity parallel to the line of
  // sight puts the focus of expansion at the screen centre and drives the old
  // code into its fallback, where it fails for the easy reason; off-axis, the
  // old code produces a perfectly reasonable-looking non-vertical streak and
  // is still wrong, which is the case worth guarding.
  const velocity = new THREE.Vector3(0.3, 0.15, -1).normalize()

  /** The vanishing point of the velocity: where a static field flows FROM. */
  const focusOfExpansion = project(velocity.clone().multiplyScalar(1e6))

  const WIDTH = 0.07
  const LENGTH = 0.97

  /** Four motes spread across the view, none of them on the flow axis. */
  const MOTES: readonly THREE.Vector3[] = [
    new THREE.Vector3(-9, 4, -40),
    new THREE.Vector3(8, -5, -30),
    new THREE.Vector3(-3, -7, -55),
    new THREE.Vector3(11, 6, -70),
  ]

  /** The streak's direction ON SCREEN, from the two ends of the drawn quad. */
  const screenDirection = (
    corner: (c: THREE.Vector3, k: { x: number; y: number }) => THREE.Vector3,
    centre: THREE.Vector3,
  ): THREE.Vector2 => {
    const a = project(corner(centre, { x: 0, y: -0.5 }))
    const b = project(corner(centre, { x: 0, y: 0.5 }))
    return b.sub(a).normalize()
  }

  /** The shipped construction. */
  const shipped = (centre: THREE.Vector3, k: { x: number; y: number }): THREE.Vector3 =>
    moteCorner(centre, velocity.clone(), k, WIDTH, LENGTH)

  /**
   * The construction DEV-318 removed, written out so the guard has a loud
   * counterpart: the velocity's xy pair in view space, normalised, with a
   * screen-up fallback, applied to the xy of the centre only.
   */
  const screenShadow = (centre: THREE.Vector3, k: { x: number; y: number }): THREE.Vector3 => {
    const vx = velocity.x
    const vy = velocity.y
    const len = Math.hypot(vx, vy)
    const along = len > 1e-5 ? new THREE.Vector2(vx / len, vy / len) : new THREE.Vector2(0, 1)
    const side = new THREE.Vector2(-along.y, along.x)
    return new THREE.Vector3(
      centre.x + side.x * (k.x * WIDTH) + along.x * (k.y * LENGTH),
      centre.y + side.y * (k.x * WIDTH) + along.y * (k.y * LENGTH),
      centre.z,
    )
  }

  it('lays every streak along the line from the focus of expansion', () => {
    // The claim, stated as optic flow and nothing else. |dot| rather than dot,
    // because a streak is a LINE and a line has no sign — which is the one
    // thing the old comment got right.
    for (const centre of MOTES) {
      const radial = project(centre).sub(focusOfExpansion).normalize()
      const drawn = screenDirection(shipped, centre)
      expect(Math.abs(drawn.dot(radial)), `mote at ${centre.toArray().join(',')}`).toBeGreaterThan(
        0.99,
      )
    }
  })

  it('therefore does NOT draw them all parallel, which is what rain is', () => {
    const dirs = MOTES.map((m) => screenDirection(shipped, m))
    // Every pair must disagree. Four motes, six pairs, and the spread is the
    // whole difference between a flow field and a downpour.
    let worst = 1
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        worst = Math.min(
          worst,
          1 - Math.abs((dirs[i] as THREE.Vector2).dot(dirs[j] as THREE.Vector2)),
        )
      }
    }
    expect(worst).toBeGreaterThan(0.01)
  })

  it('DISAGREES with the screen-shadow answer, so the two above can fail', () => {
    // The loud counterpart. A guard that agrees with the bug is not a guard.
    const dirs = MOTES.map((m) => screenDirection(screenShadow, m))
    // The old code gave every mote ONE screen direction, whatever its position.
    for (const d of dirs) {
      expect(Math.abs(d.dot(dirs[0] as THREE.Vector2))).toBeGreaterThan(0.9999)
    }
    // And that direction cannot be radial from the flow's vanishing point at
    // more than one place, so the first assertion above really does bite.
    const offRadial = MOTES.filter((m, i) => {
      const radial = project(m).sub(focusOfExpansion).normalize()
      return Math.abs((dirs[i] as THREE.Vector2).dot(radial)) <= 0.99
    })
    expect(offRadial.length, 'the old construction was radial everywhere').toBeGreaterThan(0)
  })

  it('draws a streak of the authored LENGTH along the velocity', () => {
    // The other half of the geometry, and the one a direction test cannot see:
    // the quad is `length` long end to end, in metres, along the velocity.
    const centre = MOTES[0] as THREE.Vector3
    const a = shipped(centre, { x: 0, y: -0.5 })
    const b = shipped(centre, { x: 0, y: 0.5 })
    expect(a.distanceTo(b)).toBeCloseTo(LENGTH, 6)
    expect(b.clone().sub(a).normalize().dot(velocity)).toBeCloseTo(1, 6)
  })

  it('faces the eye: the width axis is across the line of sight', () => {
    // Perpendicular to the streak AND to the line of sight is what makes a
    // stretched billboard readable rather than edge-on.
    const centre = MOTES[1] as THREE.Vector3
    const l = shipped(centre, { x: -0.5, y: 0 })
    const r = shipped(centre, { x: 0.5, y: 0 })
    const across = r.clone().sub(l)
    expect(across.length()).toBeCloseTo(WIDTH, 6)
    expect(Math.abs(across.clone().normalize().dot(velocity))).toBeLessThan(1e-6)
    expect(Math.abs(across.clone().normalize().dot(centre.clone().normalize()))).toBeLessThan(1e-6)
  })

  it('builds it in THREE dimensions in the shipped shader, not two', () => {
    // The structural half, and it carries real weight: every assertion above
    // runs `moteCorner`, so fixing the twin and leaving the GLSL alone would
    // keep them all green. That is the shape of the defect this project has
    // shipped twice (DEV-295, and the uniform in the wrong stage a week later).
    //
    // Comments are STRIPPED first. A guard that classifies by substring is
    // answered by prose about it, and the paragraph in `motes.ts` explaining
    // this very change would otherwise decide its own verdict (DEV-287).
    const code = MOTE_VERTEX_SHADER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // The streak is added to all three components of the view-space centre.
    expect(code).toMatch(/centre\.xyz\s*\+=/)
    // The width axis comes from a cross product with the line of sight, which
    // is the whole of what the 2D form could not do.
    expect(code).toMatch(/cross\(\s*along\s*,\s*centre\.xyz\s*\)/)
    // And the 2D shadow is gone: no xy-only offset of the centre, and no
    // normalise of the velocity's xy pair.
    expect(code).not.toMatch(/centre\.xy\s*\+=/)
    expect(code).not.toMatch(/normalize\(\s*vView\.xy\s*\)/)
  })
})
