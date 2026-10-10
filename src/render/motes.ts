// src/render/motes.ts — the near-field air. ANNIVERSARY.md S1, DEV-080.
//
// ── What it is for ────────────────────────────────────────────────────────
//
// Perceived speed is optic flow, and optic flow for a point at distance d is
// v/d — so the near field dominates and nothing else comes close. ANNIVERSARY
// §2.1 measured what the port actually gives the eye: at 90 m/s, 300 m above
// the island, looking 20 degrees down through the canopy, the ground slides
// past at TWO DEGREES A SECOND. A car at 30 m/s is doing 344, because the
// roadside is five metres away. *The sense of speed is not missing; it is at
// 300 m, where nothing is.*
//
// This is the roadside. A pool of small faceted triangles in a shell around the
// eye, static in the world while they live, respawning ahead once they fall
// behind — so the player flies THROUGH them and the metre gets a length again.
// At 3 m a mote passes at 30 rad/s.
//
// ── The pattern, and where it came from ──────────────────────────────────
//
// king-tide's `render/wind-trails.ts` (ANNIVERSARY §6): a fixed pool scattered
// in a shell around and ahead of the camera, static in the world, respawning
// near the camera as each one ends, one merged geometry and ONE draw call, the
// CPU touching a slot only when it respawns. That repo is WebGPU/TSL, so the
// shader does not cross; the pool does. Its teleport guard crosses too — a race
// restart or a level change orphans the whole pool, and reseeding beats
// watching the whole pool stream back from a place you no longer are.
//
// ── Why a mote is born FAR and dies behind you ───────────────────────────
//
// The tempting version spawns across the whole shell, which puts half the pool
// inside 15 m at full alpha: hundreds of specks a second appearing out of
// nothing, in the one part of the frame the eye is best at. So a respawn lands
// in the outermost slice only (`SPAWN_SHELL`, inside the far fade's own band and
// near the end of it, so a mote is born at under a tenth of its alpha) and the
// near field fills itself BY TRANSIT, because a mote 50 m ahead and 5 degrees
// off the velocity axis is a mote that will pass your canopy. Only the initial
// seed spreads across the shell, and that happens on a load or a teleport,
// where there is nothing to pop against.
//
// ── What this module does not know ───────────────────────────────────────
//
// The preset. It takes resolved numbers (`MoteSpec`) and `game/air.ts` is what
// reads `EditionMotes` and the comfort slider and does the multiplying — the
// same split `render/particles.ts` and `game/particle-fx.ts` already live
// under. It also takes no `dt`: motes do not move, so nothing here can be
// frame-rate dependent.

import * as THREE from 'three'
import type { EditionFeature, EditionMotes } from '@/content/edition-schema'
import { stretchedCorner } from '@/render/particles'
import { makeRandom } from '@/sim/terrain/faceted'

/**
 * The field, as numbers. Already scaled by the comfort slider — `count` and
 * `alpha` are what to draw, not what the preset asked for.
 */
export type MoteSpec = Omit<EditionMotes, keyof EditionFeature>

/** A velocity, in the shape `flight.jet.body.velocity` arrives in. */
export interface Vec3Like {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The fraction of the shell, measured in from the outside, that the far fade runs over. */
export const SPAWN_BAND = 0.35

/**
 * The outermost slice of the shell a respawn may land in, as a fraction of the
 * outer radius.
 *
 * It sits INSIDE the fade band and near the far end of it, so a mote is always
 * born at almost no alpha and brightens as it approaches. That is the whole
 * trick: spawn across the shell instead and half the pool appears at full alpha
 * inside 15 m, which is hundreds of specks a second popping into the part of
 * the frame the eye is best at. The two numbers have to agree, and
 * `motes.test.ts` asserts the RELATIONSHIP — the alpha a mote is born at —
 * rather than either value.
 */
export const SPAWN_SHELL = 0.05

/** Metres behind the eye a mote may drift before it is recycled. */
export const BEHIND_MARGIN = 2

/** The radii a respawn may use: the outermost slice, ahead of the eye. */
export const respawnRadii = (spec: MoteSpec): readonly [number, number] => [
  Math.max(spec.innerRadius, spec.outerRadius * (1 - SPAWN_SHELL)),
  spec.outerRadius,
]

/**
 * The far fade, mirroring the ONE line of GLSL that draws it.
 *
 * A JS copy of a shader line is a thing that drifts, so it shares the constant
 * with the shader (which is interpolated from `SPAWN_BAND`) and exists for one
 * reason: a test can ask what alpha a mote is BORN at, which is the property
 * that matters and is invisible to an assertion about radii.
 */
export const fadeOutAt = (distance: number, outerRadius: number): number => {
  const start = outerRadius * (1 - SPAWN_BAND)
  const t = Math.min(1, Math.max(0, (distance - start) / (outerRadius - start)))
  return 1 - t * t * (3 - 2 * t)
}

/**
 * The mote's drawn length: its own size, plus the distance it travels in
 * `stretchSeconds`. A speck at 40 m/s and a short streak at 180.
 */
export const moteLength = (spec: MoteSpec, speed: number): number =>
  spec.size + spec.stretchSeconds * Math.max(0, speed)

/**
 * Peak alpha at this speed. Zero below `minSpeed` — which is deliberately NOT
 * 2016's 25 m/s effects threshold; that number is generated and belongs to the
 * shipped systems (hard rule 3).
 */
export const moteAlpha = (spec: MoteSpec, speed: number): number => {
  const span = spec.fullSpeed - spec.minSpeed
  if (!(span > 0)) return speed >= spec.minSpeed ? spec.alpha : 0
  const k = Math.min(1, Math.max(0, (speed - spec.minSpeed) / span))
  return spec.alpha * k
}

/**
 * Has this mote been passed?
 *
 * `offset` is the mote MINUS the eye and `forward` is the unit velocity, so the
 * dot product is how far ahead it is. Behind by more than the margin, or past
 * the shell, and the slot is recycled — the margin is what stops a mote sitting
 * exactly abeam from respawning on alternate frames.
 */
export const isPassed = (offset: Vec3Like, forward: Vec3Like, outerRadius: number): boolean => {
  const ahead = offset.x * forward.x + offset.y * forward.y + offset.z * forward.z
  if (ahead < -BEHIND_MARGIN) return true
  return Math.hypot(offset.x, offset.y, offset.z) > outerRadius
}

const _u = new THREE.Vector3()
const _w = new THREE.Vector3()

/**
 * Where a mote goes, RELATIVE TO THE EYE.
 *
 * Direction: a cone about `forward` whose concentration is `aheadBias` — 0 is
 * uniform across the hemisphere ahead, 1 hugs the velocity axis. Never behind,
 * because a mote spawned behind is a mote that respawns on the next frame and
 * every frame after it.
 *
 * Radius: LOG-uniform between the two, which is equal counts per octave of
 * distance. Uniform-in-volume would put 99.9% of a 4-55 m shell past 4 m and
 * the mean at 41, which is the far field the game already has too much of.
 */
export const spawnOffset = (
  rand: () => number,
  spec: MoteSpec,
  forward: Vec3Like,
  rMin: number,
  rMax: number,
  out: THREE.Vector3,
): THREE.Vector3 => {
  const bias = Math.min(1, Math.max(0, spec.aheadBias))
  // t^(1+4b) pushes the mass toward 0, so `cos` toward 1 — the velocity axis.
  const cos = 1 - rand() ** (1 + 4 * bias)
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos))
  const phi = rand() * Math.PI * 2
  const r = rMin * (rMax / rMin) ** rand()

  // An orthonormal pair across the forward axis. `forward` is unit by contract.
  _u.set(forward.x, forward.y, forward.z)
  _w.set(0, 1, 0)
  if (Math.abs(_u.y) > 0.9) _w.set(1, 0, 0)
  _w.cross(_u).normalize()
  const right = _w
  const up = _tmpUp.copy(_u).cross(right).normalize()

  return out
    .set(
      _u.x * cos + right.x * sin * Math.cos(phi) + up.x * sin * Math.sin(phi),
      _u.y * cos + right.y * sin * Math.cos(phi) + up.y * sin * Math.sin(phi),
      _u.z * cos + right.z * sin * Math.cos(phi) + up.z * sin * Math.sin(phi),
    )
    .multiplyScalar(r)
}
const _tmpUp = new THREE.Vector3()

export interface MoteField {
  readonly object: THREE.Object3D
  /** Instances drawn on the last update. Zero is a valid answer. */
  readonly active: number
  /** The live numbers, for a test to read back. */
  readonly spec: MoteSpec | null
  /** A preset flip or a slider move. `null` draws nothing. */
  setSpec(spec: MoteSpec | null): void
  /**
   * One frame. `velocity` null — the hangar, the title, a paused run — draws
   * nothing and leaves the pool where it is.
   *
   * The camera's WORLD position, never `camera.position`: in the cockpit the
   * camera is a child of the XR rig and the local one is the head pose inside
   * it, which is the origin until you lean (CLAUDE.md trap 18).
   */
  update(camera: THREE.Camera, velocity: Vec3Like | null): void
  dispose(): void
}

const VERTEX = /* glsl */ `
attribute vec3 iPosition;
attribute float iShade;
uniform vec3 uVelocity;    // unit, world space; the axis a mote is drawn along
uniform float uSize;
uniform float uLength;
uniform float uAlpha;
uniform float uNear;
uniform float uFar;
uniform vec3 uColorLight;
uniform vec3 uColorDark;
varying vec4 vColor;

void main() {
  vec4 centre = modelViewMatrix * vec4(iPosition, 1.0);
  // View-space length IS the distance from the eye, and it is read BEFORE the
  // billboard offset moves the vertex off the mote's centre.
  float d = length(centre.xyz);
  // Camera-facing, and stretched along the apparent motion — built in THREE
  // dimensions and then projected. The motes are static and the eye moves, so
  // the line they are drawn along is the ship's velocity; a line has no sign,
  // so its direction needs no flipping.
  //
  // ── DEV-318: this took the velocity's 2D SCREEN SHADOW, and that is what
  //    made it rain ──
  //
  // The old form normalised the view-space velocity's xy pair and fell back to
  // a fixed screen-up pair when that was short. Two things follow, and both
  // are visible from the cockpit:
  //
  //   The velocity here is a UNIFORM — one value for every mote — so its
  //   screen shadow gave EVERY mote the same streak direction AND the same
  //   length. Correct optic flow radiates from the focus of expansion: a mote
  //   up-left of centre must streak up-left. Parallel equal streaks are not
  //   optic flow, they are weather.
  //
  //   And when you fly along your velocity, which is most of the time, that xy
  //   pair goes to zero: the shared direction became a normalised near-zero
  //   residual that swung with any small pitch, and under the epsilon it
  //   snapped to the fallback, which was dead screen-vertical. At 150 m/s a
  //   mote is 0.97 m long against a 0.07 m size, so these are streaks.
  //
  // This is DEV-138 exactly, one file over: render/particles.ts had the same
  // 2D shadow, and its own comment already describes the symptom as a
  // full-length vertical line that is not foreshortened. The arithmetic below
  // is that file's fix, and moteCorner is its TypeScript twin — change one and
  // change the other. (Written without the offending expressions spelled out:
  // the guard for this sweeps the shader as text, and prose that quotes a
  // marker answers the guard that looks for it. CLAUDE.md, DEV-287.)
  vec3 vView = (modelViewMatrix * vec4(uVelocity, 0.0)).xyz;
  float vLen = length(vView);
  vec3 along = vLen > 1e-5 ? vView / vLen : vec3(0.0, 1.0, 0.0);
  // Perpendicular to the streak AND to the line of sight, so the width faces
  // the eye. Zero only when the streak points at the eye, where its two ends
  // project to one point and any width axis is as good as another.
  vec3 side = cross(along, centre.xyz);
  float sLen = length(side);
  if (sLen > 1e-5) {
    side /= sLen;
  } else {
    vec3 ref = abs(along.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    side = normalize(cross(along, ref));
  }
  vec2 corner = position.xy;
  // A spread of sizes, off the same per-mote random that picks the shade.
  float w = uSize * (0.6 + 0.8 * iShade);
  centre.xyz += side * (corner.x * w) + along * (corner.y * uLength);

  // Faded to nothing at the shell's edge, where motes are born, and inside the
  // canopy, where one would be a fault rather than air. (Named away from
  // "near"/"far", which are the fields of gl_DepthRange.)
  float fadeIn = smoothstep(uNear * 0.6, uNear * 1.6, d);
  float fadeOut = 1.0 - smoothstep(uFar * ${(1 - SPAWN_BAND).toFixed(2)}, uFar, d);
  // Light motes and dark ones, and every shade between. Whatever is behind the
  // field — a bright mauve sky or a dark hillside — part of it has contrast.
  vColor = vec4(mix(uColorDark, uColorLight, iShade), uAlpha * fadeIn * fadeOut);
  gl_Position = projectionMatrix * centre;
}
`

const FRAGMENT = /* glsl */ `
varying vec4 vColor;

void main() {
  if (vColor.a <= 0.002) discard;
  gl_FragColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`

/**
 * The vertex program, exported so a test can hold it to `moteCorner` — and so
 * one can sweep it for the 2D shadow that DEV-318 removed. A `toContain` over
 * the SOURCE is answered by a comment (CLAUDE.md, DEV-287), so the test that
 * does that strips comments first.
 */
export const MOTE_VERTEX_SHADER = VERTEX

/**
 * One corner of a mote's stretched billboard, in VIEW space — `VERTEX`'s streak
 * block, line for line, so a projection test can run it in node.
 *
 * It DELEGATES rather than repeating the arithmetic: since DEV-318 this is the
 * same construction `render/particles.ts` has used since DEV-138, and two
 * copies of one formula is the thing that drifts. `centre` and `velocity` are
 * already in view space; `corner` is the triangle's (x, y) in ±0.5; `width` is
 * the rendered width and `length` the full drawn length (`moteLength`).
 */
export const moteCorner = (
  centre: THREE.Vector3,
  velocity: THREE.Vector3,
  corner: { x: number; y: number },
  width: number,
  length: number,
): THREE.Vector3 => stretchedCorner(centre, velocity, corner, width, length)

/** The game's particle shape: a triangle, apex down, one unit across. */
const triangleGeometry = (): THREE.InstancedBufferGeometry => {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([0, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
  )
  return g
}

export const createMoteField = (
  spec: MoteSpec | null = null,
  { seed = 0x5eed_a12 }: { seed?: number } = {},
): MoteField => {
  const geometry = triangleGeometry()
  const uniforms = {
    uVelocity: { value: new THREE.Vector3(0, 0, 1) },
    uSize: { value: 0 },
    uLength: { value: 0 },
    uAlpha: { value: 0 },
    uNear: { value: 1 },
    uFar: { value: 1 },
    uColorLight: { value: new THREE.Color(1, 1, 1) },
    uColorDark: { value: new THREE.Color(0, 0, 0) },
  }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    // OVER, not ADD: half the field is darker than the sky on purpose, and an
    // additive mote cannot be darker than anything. The fragment writes
    // premultiplied colour, which is what `premultipliedAlpha` tells three.
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  })

  // BEFORE anything else: an InstancedBufferGeometry's `instanceCount` defaults
  // to Infinity, and this object goes into the scene at boot and is rendered
  // for every frame of the title screen before the first `update` runs.
  geometry.instanceCount = 0

  const mesh = new THREE.Mesh(geometry, material)
  mesh.visible = false
  mesh.name = 'motes'
  // World-space positions in the attribute and the mesh at the origin, so
  // three's bounding sphere would be about a point that means nothing.
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  // After the terrain and the water, with the gate spray (renderOrder 10).
  mesh.renderOrder = 9

  let live: MoteSpec | null = spec
  let capacity = 0
  let positions = new Float32Array(0)
  let iPosition = new THREE.InstancedBufferAttribute(positions, 3)
  let iShade = new THREE.InstancedBufferAttribute(new Float32Array(0), 1)
  let primed = false
  let count = 0

  const rand = makeRandom(seed >>> 0)
  const eye = new THREE.Vector3()
  const lastEye = new THREE.Vector3()
  const forward = new THREE.Vector3()
  const offset = new THREE.Vector3()

  const ensureCapacity = (n: number): void => {
    if (n <= capacity) return
    // Grows, never shrinks: a slider move must not reallocate a GPU buffer
    // every time it passes through `light` on the way to `full`.
    capacity = n
    positions = new Float32Array(capacity * 3)
    iPosition = new THREE.InstancedBufferAttribute(positions, 3)
    iPosition.setUsage(THREE.DynamicDrawUsage)
    const shades = new Float32Array(capacity)
    for (let i = 0; i < capacity; i++) shades[i] = rand()
    iShade = new THREE.InstancedBufferAttribute(shades, 1)
    geometry.setAttribute('iPosition', iPosition)
    geometry.setAttribute('iShade', iShade)
    primed = false
  }

  /** Put slot `i` somewhere ahead, in world space. */
  const place = (i: number, s: MoteSpec, rMin: number, rMax: number): void => {
    spawnOffset(rand, s, forward, rMin, rMax, offset)
    positions[i * 3] = eye.x + offset.x
    positions[i * 3 + 1] = eye.y + offset.y
    positions[i * 3 + 2] = eye.z + offset.z
  }

  const field: MoteField = {
    object: mesh,
    get active() {
      return geometry.instanceCount
    },
    get spec() {
      return live
    },

    setSpec(next: MoteSpec | null): void {
      live = next
      if (!next || next.count <= 0) {
        count = 0
        geometry.instanceCount = 0
        mesh.visible = false
        return
      }
      count = Math.floor(next.count)
      ensureCapacity(count)
      uniforms.uSize.value = next.size
      uniforms.uNear.value = next.innerRadius
      uniforms.uFar.value = next.outerRadius
      uniforms.uColorLight.value.setRGB(
        next.colorLight[0] ?? 1,
        next.colorLight[1] ?? 1,
        next.colorLight[2] ?? 1,
      )
      uniforms.uColorDark.value.setRGB(
        next.colorDark[0] ?? 0,
        next.colorDark[1] ?? 0,
        next.colorDark[2] ?? 0,
      )
    },

    update(camera: THREE.Camera, velocity: Vec3Like | null): void {
      const s = live
      if (!s || count === 0 || !velocity) {
        geometry.instanceCount = 0
        mesh.visible = false
        return
      }
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
      const alpha = moteAlpha(s, speed)
      if (!(alpha > 0) || !(speed > 1e-3)) {
        geometry.instanceCount = 0
        mesh.visible = false
        return
      }
      camera.getWorldPosition(eye)
      forward.set(velocity.x, velocity.y, velocity.z).divideScalar(speed)

      // A restart, an elevator, a level change: the pool belongs to a place the
      // eye no longer is, and streaming the whole pool home one frame at a time is
      // worse than starting again. king-tide's guard, same reason.
      const jumped = primed && eye.distanceToSquared(lastEye) > s.outerRadius * s.outerRadius
      const [bandMin, bandMax] = respawnRadii(s)
      if (!primed || jumped) {
        // The only spread across the WHOLE shell, and the only O(pool) write:
        // there is nothing on screen yet to pop against.
        for (let i = 0; i < count; i++) place(i, s, s.innerRadius, s.outerRadius)
        primed = true
      } else {
        // The steady state. The scan is arithmetic over the pool; the WRITES —
        // the part that costs — are O(respawns).
        for (let i = 0; i < count; i++) {
          offset.set(
            (positions[i * 3] ?? 0) - eye.x,
            (positions[i * 3 + 1] ?? 0) - eye.y,
            (positions[i * 3 + 2] ?? 0) - eye.z,
          )
          if (isPassed(offset, forward, s.outerRadius)) place(i, s, bandMin, bandMax)
        }
      }
      lastEye.copy(eye)

      uniforms.uVelocity.value.copy(forward)
      uniforms.uLength.value = moteLength(s, speed)
      uniforms.uAlpha.value = alpha
      geometry.instanceCount = count
      iPosition.needsUpdate = true
      mesh.visible = true
    },

    dispose(): void {
      geometry.dispose()
      material.dispose()
    },
  }

  if (spec) field.setSpec(spec)
  return field
}
