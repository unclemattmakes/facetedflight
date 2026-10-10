// src/render/life-leapers.ts — leaping sea life (the dolphins), drawn mid-leap. DEV-449; the fish went with DEV-545.
//
// `sim/life/pods.ts` says where each animal is and, as a pure function of the
// clock, where it is in its leap; this draws one `InstancedMesh` per kind and
// moves the instances every frame. An animal under the water is not drawn
// (its matrix is scaled to nothing, so the kind stays one draw with a fixed
// instance count), an animal in the air rides its parabola nose-first.
//
// ── The water it leaves and re-enters is the DRAWN water ──────────────────
//
// The leap's two ends are hull samples of the boats' own kind
// (`render/life-boats.ts`'s `HullSample`, the triangle `sim/life/sea-facet.ts`
// rebuilt under that point): the water height there this frame, wave and
// bob included. The arc rides a straight line between the two, so the animal
// leaves and re-enters at the surface the shader drew rather than at a
// collider two metres off it.
//
// ── The frame ─────────────────────────────────────────────────────────────
//
// polyfish's models face +z, up +y (the converter refuses one whose tail bone
// is not behind). SIM heading `h` travels along `(sin h, cos h)`, which in
// THREE is `(sin h, 0, −cos h)`; the nose is that, pitched up the arc. The
// basis is written out, not `lookAt`'d (trap 22: two conventions are live in
// this renderer at once) — `leaperRotation` is exported and tested for it.
//
// The material is the scatter props' recipe, as the boats' is.
//
// ── Where it leaves the water and where it lands: a splash each (DEV-613) ──
//
// Matt, 2026-10-03: *"i'm thinking i'd see it the most w/ dolphins land in the
// water"*. A leap's two ends are the two crossings, and this field already
// knows both to the drawn wave: the frame an animal goes from under to in the
// air, it left the water at `from`; the frame it goes back under, it landed at
// `to`. Each is handed to `splash` (when the field was given one) with the
// arc's own velocity there, which is `length / air` along the heading and
// `4 H / air` up or down. A clock that jumped (a pause, a hidden kind) primes
// the field again rather than reading the jump as a leap.

import * as THREE from 'three'
import { type HullSample, hullHeight } from '@/render/life-boats'
import type { WaterDisplace } from '@/render/water'
import {
  airTime,
  type BreachSpec,
  breachDue,
  type Leaper,
  leapAt,
  leapPose,
  leapSince,
} from '@/sim/life/pods'

export interface LeaperPose {
  readonly leaper: Leaper
  /** The drawn water where the leap starts and where it ends. */
  readonly from: HullSample
  readonly to: HullSample
}

/**
 * An animal crossing the water's surface, THREE world: where (on the drawn
 * wave), how fast and which way. DEV-613. Handed to a callback and never kept
 * by this module: a caller that wants it later copies it.
 */
export interface LeapSplash {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly vx: number
  readonly vy: number
  readonly vz: number
  /** m/s, the length of (vx, vy, vz). */
  readonly speed: number
  /** True landing (into the water), false leaving it. */
  readonly entering: boolean
}

/** Seconds of the sea's clock a frame may skip before the field primes again. */
const SPLASH_PRIME_SECONDS = 0.5

export interface LeaperField {
  readonly object: THREE.InstancedMesh
  /** The animals, in instance order. */
  readonly animals: readonly LeaperPose[]
  readonly count: number
  readonly triangles: number
  /**
   * One frame on the sea's clock; `bob` is the plate's rise above rest. `eye`
   * is the head's world position (THREE), which cues a breach (DEV-532) when
   * the field was given a `breach` spec; without one it is ignored.
   */
  update(seconds: number, bob: number, eye?: { x: number; y: number; z: number } | null): void
  /** How many were in the air at the last update. */
  airborne(): number
  /** How many pod breaches have been cued since the field was built. */
  breaches(): number
  dispose(): void
}

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _fwd = new THREE.Vector3()
const _up = new THREE.Vector3()
const _side = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _m = new THREE.Matrix4()
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/**
 * The animal's rotation: its +z along SIM heading `heading` pitched up by
 * `pitch`, its +y as near world up as that allows. A rotation (x = y × z).
 */
export const leaperRotation = (
  heading: number,
  pitch: number,
  out: THREE.Quaternion,
): THREE.Quaternion => {
  const c = Math.cos(pitch)
  _fwd.set(Math.sin(heading) * c, Math.sin(pitch), -Math.cos(heading) * c)
  // Up: world up with its share along the nose removed.
  _up.set(0, 1, 0).addScaledVector(_fwd, -_fwd.y).normalize()
  _side.crossVectors(_up, _fwd)
  _basis.makeBasis(_side, _up, _fwd)
  return out.setFromRotationMatrix(_basis)
}

export const createLeaperField = (
  name: string,
  geometry: THREE.BufferGeometry,
  animals: readonly LeaperPose[],
  gravity: number,
  displace: WaterDisplace,
  applyFog?: (material: THREE.Material) => void,
  breach: BreachSpec | null = null,
  splash: ((s: LeapSplash) => void) | null = null,
): LeaperField => {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  })
  applyFog?.(material)
  // One program with the boats and the scatter. three keys `vertexAlphas` on
  // a FOUR-wide colour, and everything out of `convert-fbx.py` is RGBA; the
  // creature bakes are RGB, and that alone compiled three programs of their
  // own (161 against 158 at the same view, DEV-449's first read). Alpha 1:
  // opaque is the contract `convert-life.mjs --check` holds the file to.
  const rgb = geometry.getAttribute('color')
  if (rgb && rgb.itemSize === 3) {
    const rgba = new Float32Array(rgb.count * 4)
    for (let i = 0; i < rgb.count; i++) {
      rgba[i * 4] = rgb.getX(i)
      rgba[i * 4 + 1] = rgb.getY(i)
      rgba[i * 4 + 2] = rgb.getZ(i)
      rgba[i * 4 + 3] = 1
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4))
  }
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, animals.length))
  mesh.name = name
  mesh.count = animals.length
  mesh.castShadow = false
  mesh.receiveShadow = false
  // They move by metres a second and spread over kilometres: a sphere that
  // held them all would be the whole course. Drawn whole, like the flocks.
  mesh.frustumCulled = false
  for (let i = 0; i < animals.length; i++) mesh.setMatrixAt(i, ZERO)
  const pose = leapPose()
  let up = 0
  const tris = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3

  // DEV-532's breach: each pod's centre (SIM plan), its mean leap time, when it
  // was last cued, and how long its breach runs; each animal's place in its
  // pod, which is its stagger.
  const pods = new Map<
    number,
    {
      x: number
      z: number
      air: number
      n: number
      cuedAt: number
      span: number
      /** The drawn sea's rest height under the pod (its leaps' start samples, averaged). */
      seaY: number
      members: Leaper[]
    }
  >()
  const order: number[] = []
  const held = new Uint8Array(animals.length)
  const _probe = leapPose()
  for (const a of animals) {
    const p = pods.get(a.leaper.pod) ?? {
      x: 0,
      z: 0,
      air: 0,
      n: 0,
      cuedAt: Number.NEGATIVE_INFINITY,
      span: 0,
      seaY: 0,
      members: [],
    }
    order.push(p.n)
    p.members.push(a.leaper)
    const air = airTime(a.leaper.height, gravity)
    p.x += a.leaper.x
    p.z += a.leaper.z
    p.air += air
    const c = a.from.corners
    const w = a.from.weights
    p.seaY += w[0] * (c[1] as number) + w[1] * (c[4] as number) + w[2] * (c[7] as number)
    // The breach runs until its LAST animal is back in: its stagger plus its air.
    p.span = Math.max(p.span, (breach ? breach.stagger * p.n : 0) + air)
    p.n++
    pods.set(a.leaper.pod, p)
  }
  for (const p of pods.values()) {
    p.x /= p.n
    p.z /= p.n
    p.air /= p.n
    p.seaY /= p.n
  }
  let lastEye: { x: number; z: number; t: number } | null = null
  let cued = 0
  // DEV-613: who was in the air at the last update, and when that was. Not
  // primed until one update has recorded it.
  const wasUp = new Uint8Array(animals.length)
  let splashPrimed = false
  let splashAt = 0
  /** Reused for every crossing; the callback copies what it keeps. */
  const crossing = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, entering: false }
  const cross = (a: LeaperPose, entering: boolean, seconds: number, bob: number): void => {
    if (!splash) return
    const l = a.leaper
    const air = airTime(l.height, gravity)
    const end = entering ? a.to : a.from
    const half = (entering ? 1 : -1) * (l.length / 2)
    const h = l.heading
    const across = l.length / air
    const up = ((entering ? -4 : 4) * l.height) / air
    // SIM (x, z) along the heading, then the z flip into THREE.
    crossing.x = l.x + Math.sin(h) * half
    crossing.y = hullHeight(end, displace, seconds, bob)
    crossing.z = -(l.z + Math.cos(h) * half)
    crossing.vx = Math.sin(h) * across
    crossing.vy = up
    crossing.vz = -Math.cos(h) * across
    crossing.speed = Math.hypot(across, up)
    crossing.entering = entering
    splash(crossing)
  }

  const cue = (
    seconds: number,
    eye: { x: number; y: number; z: number } | null | undefined,
  ): void => {
    if (!breach || !eye) {
      lastEye = null
      return
    }
    // SIM plan: the z flip.
    const ex = eye.x
    const ez = -eye.z
    const was = lastEye
    lastEye = { x: ex, z: ez, t: seconds }
    const dt = was ? seconds - was.t : 0
    // A stall, a pause or a hidden tab says nothing about a velocity.
    if (!was || !(dt > 0) || dt > 0.5) return
    const vx = (ex - was.x) / dt
    const vz = (ez - was.z) / dt
    for (const p of pods.values()) {
      if (seconds - p.cuedAt < p.span + breach.rest) continue
      // The eye's height over this pod's water at rest: the sea's own sample.
      if (!breachDue(p.x, p.z, ex, ez, vx, vz, p.air, breach, eye.y - p.seaY)) continue
      // Never over a leap already in the air: that animal would jump from one
      // arc to another. The cue waits a frame or two for it to come down.
      if (p.members.some((l) => leapAt(l, seconds, gravity, _probe).airborne)) continue
      p.cuedAt = seconds
      cued++
    }
  }

  return {
    object: mesh,
    animals,
    count: animals.length,
    triangles: tris * animals.length,
    update(seconds, bob, eye) {
      cue(seconds, eye)
      up = 0
      // DEV-613: a clock that jumped, or ran back, says nothing about a leap.
      const primed =
        splashPrimed && seconds >= splashAt && seconds - splashAt <= SPLASH_PRIME_SECONDS
      splashPrimed = true
      splashAt = seconds
      for (const [i, a] of animals.entries()) {
        const l = a.leaper
        const p = pods.get(l.pod)
        const since = p ? seconds - p.cuedAt : Number.POSITIVE_INFINITY
        // Inside its pod's breach the cue drives the leap; outside, the period.
        if (breach && p && since >= 0 && since < p.span) {
          leapSince(l, since - (order[i] as number) * breach.stagger, gravity, pose)
          held[i] = 1
        } else {
          leapAt(l, seconds, gravity, pose)
          // Back on the period after a breach: not mid-arc. An animal whose
          // period is in the air at that moment stays under until it is not.
          if (held[i] && pose.airborne) pose.airborne = false
          else held[i] = 0
        }
        // DEV-613: the frame it left the water, or went back in.
        const airborne = pose.airborne ? 1 : 0
        if (primed && airborne !== wasUp[i]) cross(a, airborne === 0, seconds, bob)
        wasUp[i] = airborne
        if (!pose.airborne) {
          mesh.setMatrixAt(i, ZERO)
          continue
        }
        up++
        const s = pose.along / l.length + 0.5
        const y0 = hullHeight(a.from, displace, seconds, bob)
        const y1 = hullHeight(a.to, displace, seconds, bob)
        // SIM (x, z) along the heading, then the z flip into THREE.
        const sx = l.x + Math.sin(l.heading) * pose.along
        const sz = l.z + Math.cos(l.heading) * pose.along
        _pos.set(sx, y0 + (y1 - y0) * s + pose.up, -sz)
        leaperRotation(l.heading, pose.pitch, _quat)
        _scale.set(l.scale, l.scale, l.scale)
        _m.compose(_pos, _quat, _scale)
        mesh.setMatrixAt(i, _m)
      }
      mesh.instanceMatrix.needsUpdate = true
    },
    airborne: () => up,
    breaches: () => cued,
    dispose() {
      material.dispose()
      mesh.dispose()
    },
  }
}
