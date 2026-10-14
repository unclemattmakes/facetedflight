// src/render/gpu-particles.ts: the GPU half of a particle field. DEV-924,
// phase 1 of `docs/plan/GPU-PARTICLES.md`.
//
// ── What moves to the GPU, and what stays ─────────────────────────────────
//
// `particles.ts`'s CPU engine walks every LIVE particle every frame: it ages
// it, moves it, damps it, carries it with a riding emitter, evaluates the
// colour gradient and the size and rotation curves, and writes four instance
// buffers that are then uploaded. This file replaces all of that with a
// STATELESS particle: written ONCE, when it spawns, and from then on a
// closed-form function of its spawn state and its age, evaluated in the
// vertex shader.
//
// What stays on the CPU is emission, untouched: rates, bursts, the shape, the
// `rand()` stream in the order it has always been drawn, the drive, the
// palette and the per-emitter cap. `particles.ts` builds the same `Particle`
// it always built and hands it to `commit` instead of pushing it to a pool.
//
// ── The closed forms ──────────────────────────────────────────────────────
//
// The CPU steps `v += G dt; v *= max(0, 1 - d dt); p += v dt` (gravity, the
// clamp-velocity module's `dampen`, then motion). Its continuous limit is
// `dv/dt = G - d v`:
//
//   d > 0:  v(t) = G/d + (v0 - G/d) e^(-d t)
//           p(t) = p0 + (G/d) t + (v0 - G/d) (1 - e^(-d t)) / d
//   d = 0:  v(t) = v0 + G t,   p(t) = p0 + v0 t + G t^2 / 2
//
// The step form is frame-rate dependent and this is not, which is the point
// in a headset (`GPU-PARTICLES.md` section 6). Colour, size and rotation over
// life are a lookup texture (`bakeParticleLut`); rotation through the
// RUNNING INTEGRAL of its rate curve, since the CPU integrates it per step.
//
// ── Riding the emitter (DEV-308) ──────────────────────────────────────────
//
// A `local` field's particle is stored in its emitter's frame at spawn and
// multiplied by the emitter's CURRENT matrix in the shader, which is what
// `carryParticles`'s frame-to-frame delta composes to (its own header proves
// the two equal for a rigid pose; drag is a scalar, the same in every
// frame). GRAVITY separates out of the closed form, `p = [p0 + v0 f(t)] +
// G (t - f(t)) / d` with `f = (1 - e^(-d t)) / d`, so its part is added in
// WORLD space after the emitter's matrix: exact for an emitter that does not
// rotate, which is every riding system with gravity (the jump pads,
// `jumpPad_fx`), and close for one that does, where the CPU engine would
// rotate the fallen distance with the emitter.
//
// ── The TypeScript mirror ─────────────────────────────────────────────────
//
// `evaluateGpuSlot` is the vertex shader's prelude, line for line, so a node
// test can hold the GPU engine to the CPU engine without a GPU. Change one
// and change the other (`stretchedCorner` is the same arrangement for the
// billboard).

import * as THREE from 'three'

/** Texels across the lookup texture. Linear interpolation between them. */
export const GPU_LUT_WIDTH = 256
/** Lookup rows: colour-over-life max, its min, then (size hi, size lo, rotation-integral hi, rotation-integral lo). */
const LUT_ROWS = 3

/** The engine a field runs on. `cpu` is the shipped path; `gpu` is DEV-924's. */
export type ParticleEngine = 'cpu' | 'gpu'

/** What `bakeParticleLut` needs from the spec and from `particles.ts`'s evaluators. */
export interface LutInputs {
  readonly colourOverLifetime: { readonly enabled: boolean; readonly gradient: unknown } | null
  readonly sizeOverLifetime: { readonly enabled: boolean; readonly curve: unknown } | null
  readonly rotationOverLifetime: { readonly enabled: boolean; readonly curve: unknown } | null
  /** `evaluateGradient(g, t, r, out)`. */
  readonly gradient: (g: unknown, t: number, r: number, out: THREE.Vector4) => THREE.Vector4
  /** `evaluateMinMax(c, t, r)`. */
  readonly minMax: (c: unknown, t: number, r: number) => number
}

/**
 * The lookup texture's floats, `GPU_LUT_WIDTH x 3` RGBA.
 *
 * Every over-life module the CPU evaluates per particle is linear in the
 * particle's `r` (a two-gradient or two-curve mode lerps the pair by `r`), so
 * two rows, the `r = 1` and `r = 0` answers, hold all of it and the shader
 * mixes them. A module that is off bakes its identity: colour 1, size 1,
 * rotation 0.
 */
export const bakeParticleLut = (input: LutInputs): Float32Array => {
  const w = GPU_LUT_WIDTH
  const out = new Float32Array(w * LUT_ROWS * 4)
  const scratch = new THREE.Vector4()
  const colour = input.colourOverLifetime?.enabled ? input.colourOverLifetime.gradient : null
  const size = input.sizeOverLifetime?.enabled ? input.sizeOverLifetime.curve : null
  const rotation = input.rotationOverLifetime?.enabled ? input.rotationOverLifetime.curve : null
  const rate = (t: number, r: number): number => (rotation ? input.minMax(rotation, t, r) : 0)
  // Running integral of the rotation rate over normalised life, by the
  // trapezoid rule on a grid eight times finer than the texture.
  const sub = 8
  let intHi = 0
  let intLo = 0
  let prevHi = rate(0, 1)
  let prevLo = rate(0, 0)
  for (let i = 0; i < w; i++) {
    const t = i / (w - 1)
    if (i > 0) {
      for (let k = 1; k <= sub; k++) {
        const u = ((i - 1) * sub + k) / ((w - 1) * sub)
        const hi = rate(u, 1)
        const lo = rate(u, 0)
        const du = 1 / ((w - 1) * sub)
        intHi += ((prevHi + hi) / 2) * du
        intLo += ((prevLo + lo) / 2) * du
        prevHi = hi
        prevLo = lo
      }
    }
    if (colour) {
      input.gradient(colour, t, 1, scratch)
    } else {
      scratch.set(1, 1, 1, 1)
    }
    out.set([scratch.x, scratch.y, scratch.z, scratch.w], (0 * w + i) * 4)
    if (colour) {
      input.gradient(colour, t, 0, scratch)
    } else {
      scratch.set(1, 1, 1, 1)
    }
    out.set([scratch.x, scratch.y, scratch.z, scratch.w], (1 * w + i) * 4)
    out.set(
      [size ? input.minMax(size, t, 1) : 1, size ? input.minMax(size, t, 0) : 1, intHi, intLo],
      (2 * w + i) * 4,
    )
  }
  return out
}

/** One row of the lookup, interpolated at `t` in [0, 1]: the shader's `lutAt`. */
const lutAt = (lut: Float32Array, row: number, t: number, out: THREE.Vector4): THREE.Vector4 => {
  const w = GPU_LUT_WIDTH
  const x = Math.min(1, Math.max(0, t)) * (w - 1)
  const i0 = Math.floor(x)
  const i1 = Math.min(i0 + 1, w - 1)
  const f = x - i0
  const a = (row * w + i0) * 4
  const b = (row * w + i1) * 4
  return out.set(
    (lut[a] as number) + ((lut[b] as number) - (lut[a] as number)) * f,
    (lut[a + 1] as number) + ((lut[b + 1] as number) - (lut[a + 1] as number)) * f,
    (lut[a + 2] as number) + ((lut[b + 2] as number) - (lut[a + 2] as number)) * f,
    (lut[a + 3] as number) + ((lut[b + 3] as number) - (lut[a + 3] as number)) * f,
  )
}

/** One stored particle, as the shader reads it. */
export interface GpuSlot {
  /** Spawn position: the emitter's frame on a riding field, world otherwise. */
  readonly p0: THREE.Vector3
  readonly v0: THREE.Vector3
  readonly birth: number
  readonly life: number
  readonly r: number
  readonly emitter: number
  readonly size0: number
  readonly rot0: number
  /** Start colour times the palette tint. */
  readonly colour: THREE.Vector4
  /**
   * DEV-928: the line this particle spirals round, through its own path: the
   * axis (unit; its SIGN is the spin's direction), the phase it starts at
   * (radians) and the radius it starts at (m). Null: no orbit.
   */
  readonly orbit?: {
    readonly axis: THREE.Vector3
    readonly phase: number
    readonly radius: number
  } | null
}

/** The field-wide constants the closed form needs. */
export interface GpuMotion {
  /** `clampVelocity.dampen` when the module is on, else 0. */
  readonly drag: number
  /** World m/s^2, `(0, -32 x gravityModifier, 0)`: this game's gravity is 32. */
  readonly gravity: THREE.Vector3
  /** The renderer's stretch, or null for a billboard. */
  readonly stretch: { readonly lengthScale: number; readonly velocityScale: number } | null
  /**
   * DEV-928: the field's orbit, or null. `angularSpeed` rad/s about each
   * particle's own axis; the radius grows by `radiusGrow` times itself over
   * the particle's life.
   */
  readonly orbit?: { readonly angularSpeed: number; readonly radiusGrow: number } | null
}

/** What `evaluateGpuSlot` returns: the four values the CPU engine writes per particle. */
export interface GpuParticleState {
  readonly position: THREE.Vector3
  readonly velocity: THREE.Vector3
  readonly colour: THREE.Vector4
  /** size, rotation (radians), stretch length: `iParams`. */
  readonly params: THREE.Vector3
}

const _cMax = new THREE.Vector4()
const _cMin = new THREE.Vector4()
const _curves = new THREE.Vector4()

/**
 * The vertex shader's `evaluateParticle`, in TypeScript. Null where the shader
 * collapses the instance (dead, unborn, or an empty slot). `emitter` is the
 * emitter's CURRENT matrix on a riding field, null otherwise.
 */
export const evaluateGpuSlot = (
  slot: GpuSlot,
  clock: number,
  motion: GpuMotion,
  lut: Float32Array,
  emitter: THREE.Matrix4 | null,
): GpuParticleState | null => {
  const age = clock - slot.birth
  if (slot.life <= 0 || age < 0 || age >= slot.life) return null
  const t = age / slot.life
  const r = slot.r
  const d = motion.drag
  const g = motion.gravity
  const e = d > 0 ? Math.exp(-d * age) : 1
  const f = d > 0 ? (1 - e) / d : age
  const p = slot.p0.clone().addScaledVector(slot.v0, f)
  const v = slot.v0.clone().multiplyScalar(e)
  if (emitter) {
    p.applyMatrix4(emitter)
    v.applyMatrix3(new THREE.Matrix3().setFromMatrix4(emitter))
  }
  p.addScaledVector(g, d > 0 ? (age - f) / d : 0.5 * age * age)
  v.addScaledVector(g, d > 0 ? (1 - e) / d : age)
  // DEV-928: the orbit, round the particle's own axis through its path.
  const orbit = slot.orbit
  const om = motion.orbit
  if (orbit && om && orbit.radius > 0) {
    const ax = orbit.axis
    const ref = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const u = new THREE.Vector3().crossVectors(ax, ref).normalize()
    const w = new THREE.Vector3().crossVectors(ax, u)
    const rad = orbit.radius * (1 + om.radiusGrow * (age / slot.life))
    const ph = orbit.phase + om.angularSpeed * age
    p.addScaledVector(u, rad * Math.cos(ph)).addScaledVector(w, rad * Math.sin(ph))
    v.addScaledVector(u, -rad * om.angularSpeed * Math.sin(ph)).addScaledVector(
      w,
      rad * om.angularSpeed * Math.cos(ph),
    )
  }
  lutAt(lut, 0, t, _cMax)
  lutAt(lut, 1, t, _cMin)
  lutAt(lut, 2, t, _curves)
  // A two-gradient mode lerps max toward min by (1 - r): `evaluateGradient`.
  const over = _cMax.clone().lerp(_cMin, 1 - r)
  const colour = slot.colour.clone().multiply(over)
  const size = slot.size0 * (_curves.y + (_curves.x - _curves.y) * r)
  const rot = slot.rot0 + slot.life * (_curves.w + (_curves.z - _curves.w) * r) * (Math.PI / 180)
  const stretch = motion.stretch
    ? size * motion.stretch.lengthScale + v.length() * motion.stretch.velocityScale
    : 0
  return { position: p, velocity: v, colour, params: new THREE.Vector3(size, rot, stretch) }
}

/**
 * The GPU vertex program, built FROM the CPU one so the billboard and the
 * stretched streak (DEV-138, `stretchedCorner`) are the same text: the four
 * per-particle attributes become globals the prelude computes, and `main`
 * starts by computing them, or collapsing the instance when it is not alive.
 */
export const gpuVertexShader = (cpuVertex: string): string => {
  const attrs = [
    /^attribute vec3 iPosition;.*$/m,
    /^attribute vec4 iColor;.*$/m,
    /^attribute vec3 iParams;.*$/m,
    /^attribute vec3 iVelocity;.*$/m,
  ]
  let body = cpuVertex
  for (const re of attrs) {
    if (!re.test(body))
      throw new Error(`gpuVertexShader: the CPU vertex program no longer declares ${re}`)
    body = body.replace(re, '')
  }
  const main = 'void main() {'
  if (!body.includes(main)) throw new Error('gpuVertexShader: no main() in the CPU vertex program')
  body = body.replace(
    main,
    `${main}\n  if (!evaluateParticle()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }`,
  )
  return `${GPU_PRELUDE}\n${body}`
}

const GPU_PRELUDE = /* glsl */ `
attribute vec3 aSpawnPos;
attribute vec3 aSpawnVel;
attribute vec4 aLife;    // birth, life, r, emitter index
attribute vec4 aStart;   // size0, rot0, orbit radius, -
attribute vec4 aOrbit;   // orbit axis (its sign is the spin), orbit phase
attribute vec4 aColour;  // start colour x palette tint
uniform float uClock;
uniform sampler2D uLut;
uniform float uDrag;
uniform vec3 uGravity;
uniform vec2 uStretch;   // lengthScale, velocityScale
uniform float uStretched;
uniform vec2 uOrbit;     // angular speed (rad/s), radius growth over life
#ifdef RIDES
uniform sampler2D uEmitters;
#endif

vec3 iPosition;
vec4 iColor;
vec3 iParams;
vec3 iVelocity;

vec4 lutAt(int row, float t) {
  float x = clamp(t, 0.0, 1.0) * float(LUT_WIDTH - 1);
  int i0 = int(floor(x));
  int i1 = min(i0 + 1, LUT_WIDTH - 1);
  float f = x - float(i0);
  return mix(texelFetch(uLut, ivec2(i0, row), 0), texelFetch(uLut, ivec2(i1, row), 0), f);
}

// evaluateGpuSlot in gpu-particles.ts is this, line for line.
bool evaluateParticle() {
  float age = uClock - aLife.x;
  float life = aLife.y;
  if (life <= 0.0 || age < 0.0 || age >= life) return false;
  float t = age / life;
  float r = aLife.z;
  // The spawn velocity's part, in the particle's own frame...
  float e = uDrag > 0.0 ? exp(-uDrag * age) : 1.0;
  float f = uDrag > 0.0 ? (1.0 - e) / uDrag : age;
  vec3 p = aSpawnPos + aSpawnVel * f;
  vec3 v = aSpawnVel * e;
#ifdef RIDES
  int k = int(aLife.w + 0.5);
  mat4 m = mat4(
    texelFetch(uEmitters, ivec2(0, k), 0),
    texelFetch(uEmitters, ivec2(1, k), 0),
    texelFetch(uEmitters, ivec2(2, k), 0),
    texelFetch(uEmitters, ivec2(3, k), 0)
  );
  p = (m * vec4(p, 1.0)).xyz;
  v = mat3(m) * v;
#endif
  // ...and gravity's, always in WORLD space (exact for an emitter that does
  // not rotate, which is every riding emitter with gravity: the jump pads).
  p += uDrag > 0.0 ? uGravity * ((age - f) / uDrag) : uGravity * (0.5 * age * age);
  v += uDrag > 0.0 ? uGravity * ((1.0 - e) / uDrag) : uGravity * age;
  // DEV-928: the orbit, round the particle's own axis through its path.
  if (aStart.z > 0.0) {
    vec3 ax = aOrbit.xyz;
    vec3 ref = abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 u = normalize(cross(ax, ref));
    vec3 w = cross(ax, u);
    float rad = aStart.z * (1.0 + uOrbit.y * (age / life));
    float ph = aOrbit.w + uOrbit.x * age;
    p += rad * (cos(ph) * u + sin(ph) * w);
    v += rad * uOrbit.x * (-sin(ph) * u + cos(ph) * w);
  }
  vec4 over = mix(lutAt(0, t), lutAt(1, t), 1.0 - r);
  vec4 curves = lutAt(2, t);
  float size = aStart.x * (curves.y + (curves.x - curves.y) * r);
  float rot = aStart.y + life * (curves.w + (curves.z - curves.w) * r) * 0.017453292519943295;
  iPosition = p;
  iVelocity = v;
  iColor = aColour * over;
  iParams = vec3(size, rot, uStretched > 0.5 ? size * uStretch.x + length(v) * uStretch.y : 0.0);
  return true;
}
`

/** A field's GPU storage: slots written once at spawn, retired by the clock. */
export interface GpuStore {
  /** Live particles. */
  readonly live: number
  /** Store one particle; false when every slot is in use. */
  commit(slot: GpuSlot, emitterWorldToLocal: THREE.Matrix4 | null): boolean
  /** Advance to `clock`: free every slot whose particle died, telling `onDeath` its emitter. */
  retire(clock: number, onDeath: (emitter: number) => void): void
  /** The emitter's current matrix, for a riding field. Uploaded only if it changed. */
  setEmitterMatrix(index: number, matrix: THREE.Matrix4): void
  /** Push this frame's spawns and emitter moves, and the clock. */
  flush(clock: number): void
  /** For the mirror: slot `i` as stored, or null if it is free. */
  read(i: number): GpuSlot | null
  readonly highWater: number
  readonly uniforms: Record<string, THREE.IUniform>
  readonly defines: Record<string, string | number>
  dispose(): void
}

/**
 * Build the attributes onto `geometry` and return the store. `rides` is the
 * field's `simulationSpace === 'local'`; `motion` its constants; `lut` from
 * `bakeParticleLut`.
 */
export const createGpuStore = (
  geometry: THREE.InstancedBufferGeometry,
  capacity: number,
  rides: boolean,
  motion: GpuMotion,
  lut: Float32Array,
): GpuStore => {
  const n = capacity
  const spawnPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
  const spawnVel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
  const life = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const start = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const colour = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const orbit = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)
  const attrs = [
    ['aSpawnPos', spawnPos],
    ['aSpawnVel', spawnVel],
    ['aLife', life],
    ['aStart', start],
    ['aColour', colour],
    ['aOrbit', orbit],
  ] as const
  for (const [name, a] of attrs) {
    a.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(name, a)
  }
  geometry.instanceCount = 0

  // Death times in float64, so the clock comparison never rounds.
  const death = new Float64Array(n)
  const owner = new Int32Array(n)
  const used = new Uint8Array(n)
  // Free slots, lowest first, so a field that never wraps fills 0, 1, 2 ...
  const free = new Int32Array(n)
  for (let i = 0; i < n; i++) free[i] = n - 1 - i
  let freeTop = n
  let live = 0
  let highWater = 0
  let dirtyLo = Number.POSITIVE_INFINITY
  let dirtyHi = -1

  const lutTexture = new THREE.DataTexture(
    lut,
    GPU_LUT_WIDTH,
    LUT_ROWS,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  lutTexture.minFilter = THREE.NearestFilter
  lutTexture.magFilter = THREE.NearestFilter
  lutTexture.needsUpdate = true

  let emitterRows = 32
  let emitterData = new Float32Array(4 * 4 * emitterRows)
  let emitterTexture = new THREE.DataTexture(
    emitterData,
    4,
    emitterRows,
    THREE.RGBAFormat,
    THREE.FloatType,
  )
  emitterTexture.minFilter = THREE.NearestFilter
  emitterTexture.magFilter = THREE.NearestFilter
  let emittersDirty = false

  const uniforms: Record<string, THREE.IUniform> = {
    uClock: { value: 0 },
    uLut: { value: lutTexture },
    uDrag: { value: motion.drag },
    uGravity: { value: motion.gravity.clone() },
    uStretch: {
      value: new THREE.Vector2(
        motion.stretch?.lengthScale ?? 0,
        motion.stretch?.velocityScale ?? 0,
      ),
    },
    uStretched: { value: motion.stretch ? 1 : 0 },
    uOrbit: {
      value: new THREE.Vector2(motion.orbit?.angularSpeed ?? 0, motion.orbit?.radiusGrow ?? 0),
    },
    uEmitters: { value: emitterTexture },
  }
  const defines: Record<string, string | number> = { LUT_WIDTH: GPU_LUT_WIDTH }
  if (rides) defines.RIDES = ''

  const _p = new THREE.Vector3()
  const _v = new THREE.Vector3()
  const _lin = new THREE.Matrix3()

  return {
    get live() {
      return live
    },
    get highWater() {
      return highWater
    },
    uniforms,
    defines,
    commit(slot, worldToLocal) {
      if (freeTop === 0) return false
      const i = free[--freeTop] as number
      _p.copy(slot.p0)
      _v.copy(slot.v0)
      if (worldToLocal) {
        // Into the emitter's frame at spawn: the shader multiplies back out by
        // the emitter's matrix at every later frame.
        _p.applyMatrix4(worldToLocal)
        _v.applyMatrix3(_lin.setFromMatrix4(worldToLocal))
      }
      spawnPos.setXYZ(i, _p.x, _p.y, _p.z)
      spawnVel.setXYZ(i, _v.x, _v.y, _v.z)
      life.setXYZW(i, slot.birth, slot.life, slot.r, slot.emitter)
      const o = slot.orbit
      start.setXYZW(i, slot.size0, slot.rot0, o ? o.radius : 0, 0)
      if (o) orbit.setXYZW(i, o.axis.x, o.axis.y, o.axis.z, o.phase)
      colour.setXYZW(i, slot.colour.x, slot.colour.y, slot.colour.z, slot.colour.w)
      death[i] = slot.birth + slot.life
      owner[i] = slot.emitter
      used[i] = 1
      live++
      if (i + 1 > highWater) highWater = i + 1
      if (i < dirtyLo) dirtyLo = i
      if (i > dirtyHi) dirtyHi = i
      return true
    },
    retire(clock, onDeath) {
      for (let i = 0; i < highWater; i++) {
        if (!used[i] || clock < (death[i] as number)) continue
        used[i] = 0
        live--
        free[freeTop++] = i
        onDeath(owner[i] as number)
      }
      // Shrink the drawn range past trailing free slots, so an idle field
      // draws nothing at all.
      while (highWater > 0 && !used[highWater - 1]) highWater--
    },
    setEmitterMatrix(index, matrix) {
      if (index >= emitterRows) {
        while (index >= emitterRows) emitterRows *= 2
        const grown = new Float32Array(4 * 4 * emitterRows)
        grown.set(emitterData)
        emitterData = grown
        emitterTexture.dispose()
        emitterTexture = new THREE.DataTexture(
          emitterData,
          4,
          emitterRows,
          THREE.RGBAFormat,
          THREE.FloatType,
        )
        emitterTexture.minFilter = THREE.NearestFilter
        emitterTexture.magFilter = THREE.NearestFilter
        ;(uniforms.uEmitters as THREE.IUniform).value = emitterTexture
        emittersDirty = true
      }
      const o = index * 16
      const e = matrix.elements
      let same = true
      for (let k = 0; k < 16; k++) {
        if (emitterData[o + k] !== e[k]) {
          same = false
          break
        }
      }
      if (same) return
      for (let k = 0; k < 16; k++) emitterData[o + k] = e[k] as number
      emittersDirty = true
    },
    flush(clock) {
      ;(uniforms.uClock as THREE.IUniform).value = clock
      geometry.instanceCount = highWater
      if (dirtyHi >= dirtyLo) {
        for (const [, a] of attrs) {
          // DEV-919's mechanism: the slots spawned this frame, nothing else.
          a.clearUpdateRanges()
          a.addUpdateRange(dirtyLo * a.itemSize, (dirtyHi - dirtyLo + 1) * a.itemSize)
          a.needsUpdate = true
        }
        dirtyLo = Number.POSITIVE_INFINITY
        dirtyHi = -1
      }
      if (emittersDirty) {
        emitterTexture.needsUpdate = true
        emittersDirty = false
      }
    },
    read(i) {
      if (!used[i]) return null
      return {
        p0: new THREE.Vector3(spawnPos.getX(i), spawnPos.getY(i), spawnPos.getZ(i)),
        v0: new THREE.Vector3(spawnVel.getX(i), spawnVel.getY(i), spawnVel.getZ(i)),
        birth: life.getX(i),
        life: life.getY(i),
        r: life.getZ(i),
        emitter: life.getW(i),
        size0: start.getX(i),
        rot0: start.getY(i),
        colour: new THREE.Vector4(colour.getX(i), colour.getY(i), colour.getZ(i), colour.getW(i)),
        orbit:
          start.getZ(i) > 0
            ? {
                axis: new THREE.Vector3(orbit.getX(i), orbit.getY(i), orbit.getZ(i)),
                phase: orbit.getW(i),
                radius: start.getZ(i),
              }
            : null,
      }
    },
    dispose() {
      lutTexture.dispose()
      emitterTexture.dispose()
    },
  }
}
