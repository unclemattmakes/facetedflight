// src/render/dressing.ts — the generated props and the flocks, as geometry.
//
// ANNIVERSARY.md V9, DEV-089. `sim/props/dressing.ts` decides WHERE; this turns
// its answer into three objects. It knows nothing about a preset — `game/props/
// load-dressing.ts` is the twenty lines that read one — the same split
// `render/motes.ts` keeps from `game/air.ts`.
//
// ── One draw call per kind, and how the variants survive it ──────────────
//
// §5's *Measure* column for V9 is "draw calls", so a kind is ONE
// `InstancedMesh`. That is at odds with wanting three to five boulders that are
// not the same boulder: an `InstancedMesh` draws one geometry for every
// instance, so the obvious answer is one mesh per variant and four draw calls
// per kind.
//
// Instead every variant of a kind is packed into the SAME geometry as an extra
// position attribute — `aVar1`, `aVar2`, `aVar3` beside `position` — and a
// per-instance `iVariant` picks one in the vertex shader. The variants share a
// topology by construction (`generatePropVariants` says so and the test asserts
// it), so one set of indices, one set of vertex colours and one draw call cover
// all four. Four variants of an 80-triangle boulder is 2.9 KB of extra vertex
// data for the whole world.
//
// The material stays a `MeshStandardMaterial`, which is what buys the rest for
// free: three's lighting, the existing `unity-fog` patch, `flatShading` (which
// takes the normal from screen-space derivatives and is therefore correct for
// whichever variant was swapped in), and `instanceColor` for the per-placement
// tint.
//
// ── The order the two patches chain in, and why it is not arbitrary ──────
//
// `unity-fog.ts` chains onto `onBeforeCompile` and replaces the SAME hook this
// does — `#include <begin_vertex>` — and it writes `vUnityFogWorldPos` from
// `transformed`. Whichever patch is applied LAST runs its replace last and
// therefore lands its line CLOSEST to the hook, i.e. earliest in the shader. So
// the fog must go on FIRST and the variant swap second, or the fog samples the
// un-swapped vertex. The error would be under two metres on a 1–3 m prop and
// nobody would ever see it, which is exactly why it is written down instead of
// left to whoever edits this next: `loadDressing` takes the fog as a parameter
// so the order cannot be got wrong at the call site.
//
// Every patch needs a cache-key tag or two materials that differ only in their
// injected GLSL hash identically and share one compiled program, which is why
// they go through `chainShaderPatch` (`render/program-cache-key.ts`): its tag is
// required by its type.

import * as THREE from 'three'
import { chainShaderPatch } from '@/render/program-cache-key'
import type { DressingPlacements } from '@/sim/props/dressing'
import { type BirdMesh, birdAt, birdPose, type FlockPlacement } from '@/sim/props/generate-bird'
import type { PropMesh } from '@/sim/props/generate-shapes'

/** How many variant slots the packed geometry and the shader have. */
export const MAX_VARIANTS = 4

/**
 * The wing beat: radians of sweep, and beats per second.
 *
 * **The one pair of numbers this feature did not put in the preset**, and the
 * reason is `PROP_SHAPES`': they describe the generated ANIMATION the way that
 * table describes the generated geometry, not the mission and not the tuning.
 * Everything a person would want to turn — how many flocks, how big, how fast,
 * how high, what colour — is in `content/editions/anniversary.json`.
 *
 * 4 Hz is a gull rather than a hummingbird, and it is well under half the
 * headset's 72 Hz so the beat cannot alias into a strobe — the same constraint
 * `cockpit.shake.frequency` carries in its own schema note.
 */
export const WING_SWEEP = 0.6
export const WING_HZ = 4

const VARIANT_HOOK = '#include <begin_vertex>'

/**
 * The swap, as GLSL.
 *
 * A chain of compares on an attribute that is constant across an instance, so
 * every fragment of a boulder takes the same branch and the cost is nothing.
 * Written to KEEP the hook token, because `unity-fog.ts` replaces the same one
 * and a patch that consumed it would silently unfog every prop in the world.
 */
const VARIANT_SWAP = `
  if (iVariant > 2.5) transformed = aVar3;
  else if (iVariant > 1.5) transformed = aVar2;
  else if (iVariant > 0.5) transformed = aVar1;
`

const VARIANT_DECLS = `
attribute vec3 aVar1;
attribute vec3 aVar2;
attribute vec3 aVar3;
attribute float iVariant;
`

/** One kind's instanced mesh, plus what it cost. */
export interface PropField {
  readonly object: THREE.InstancedMesh
  readonly instances: number
  readonly triangles: number
  dispose(): void
}

/**
 * Pack the variants into one geometry.
 *
 * Every variant beyond the first fills a slot; slots past `variants.length`
 * repeat variant 0, so the shader needs no conditional compilation and a preset
 * that asks for two variants renders two rather than three-plus-garbage.
 */
export const packVariants = (variants: readonly PropMesh[]): THREE.BufferGeometry => {
  const base = variants[0]
  if (!base) throw new Error('dressing: a kind needs at least one generated variant')
  for (const [i, v] of variants.entries()) {
    if (v.triangleCount !== base.triangleCount) {
      throw new Error(
        `dressing: variant ${i} has ${v.triangleCount} triangles, variant 0 has ` +
          `${base.triangleCount}. Every variant of a kind shares a topology — see ` +
          '`generatePropVariants`.',
      )
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(base.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(base.normals, 3))
  // One lightness per FACE, expanded to rgb. Shared across the variants: they
  // have the same face count and the shade is a random anyway, so a variant
  // wearing variant 0's shades is indistinguishable from one wearing its own.
  const shade = new Float32Array(base.shades.length * 3)
  for (let i = 0; i < base.shades.length; i++) {
    const s = base.shades[i] as number
    shade[i * 3] = s
    shade[i * 3 + 1] = s
    shade[i * 3 + 2] = s
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(shade, 3))
  for (let slot = 1; slot < MAX_VARIANTS; slot++) {
    const v = variants[slot] ?? base
    geometry.setAttribute(`aVar${slot}`, new THREE.BufferAttribute(v.positions, 3))
  }
  return geometry
}

/** Scratch. Valid only inside one synchronous call — never stored (trap 19). */
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _tiltQuat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _matrix = new THREE.Matrix4()
const _yAxis = new THREE.Vector3(0, 1, 0)
const _axis = new THREE.Vector3()

/**
 * Build one kind's field.
 *
 * `applyFog` is called on the material BEFORE the variant patch — see the
 * header. It is a parameter rather than something the caller does afterwards
 * precisely so the order is not a thing anybody has to remember.
 *
 * `applyIllustrative` is V7's diffuse warp (DEV-092), and it gets the same
 * treatment for a different reason: it is not the ORDER that matters there — it
 * patches `RE_Direct`, which shares no hook with either of the other two — but
 * it must reach the material at CONSTRUCTION, so a boulder is never lit
 * differently from the ground it is standing on for a frame. There is no flag of
 * its own: the whole point of the row is that the props sit in the same light as
 * the terrain, and a knob that let them disagree is one nobody would want.
 */
export const createPropField = (
  variants: readonly PropMesh[],
  placements: DressingPlacements,
  applyFog?: (material: THREE.Material) => void,
  applyIllustrative?: (material: THREE.Material) => void,
): PropField => {
  const geometry = packVariants(variants)
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    // The generated meshes are already split per triangle, so they are flat by
    // construction — and this is what makes the variant swap safe: under
    // FLAT_SHADED three takes the normal from screen-space derivatives of the
    // view position and never reads the `normal` attribute, which still belongs
    // to variant 0.
    flatShading: true,
  })
  applyFog?.(material)
  applyIllustrative?.(material)
  // A brand-new material, so no once-set: nothing can reach this twice.
  chainShaderPatch(material, {
    tag: 'dressing-variants',
    vertex: (source) =>
      `${VARIANT_DECLS}${source}`.replace(VARIANT_HOOK, `${VARIANT_HOOK}${VARIANT_SWAP}`),
  })

  const mesh = new THREE.InstancedMesh(geometry, material, placements.count)
  mesh.name = `dressing:${placements.kind}`
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  // Scattered over a whole 4 km terrain, so the bounding sphere three would
  // compute around the ORIGIN mesh culls the lot. Same reason `load-props.ts`
  // turns it off for the palms.
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false

  const variant = new Float32Array(placements.count)
  for (let i = 0; i < placements.count; i++) {
    const mx = placements.positions[i * 3] as number
    const my = placements.positions[i * 3 + 1] as number
    const mz = placements.positions[i * 3 + 2] as number
    // Unity mesh space -> three: the SAME z flip `chunkGeometry` applied to the
    // terrain this group hangs under, and the same yaw negation `load-props.ts`
    // applies to the palms. Doing it here rather than in the sim is what keeps
    // one frame per layer.
    _pos.set(mx, my, -mz)
    _quat.setFromAxisAngle(_yAxis, -(placements.yaw[i] as number))
    const tilt = placements.tilt[i] as number
    if (tilt !== 0) {
      // The lean, about a horizontal axis. `tiltDir` is drawn uniformly over a
      // full turn, so this axis is isotropic and the z flip cannot bias it —
      // which is the one case where "the frame does not matter" is a fact about
      // the distribution rather than a hope about the geometry.
      const dir = placements.tiltDir[i] as number
      _axis.set(Math.cos(dir), 0, Math.sin(dir))
      _tiltQuat.setFromAxisAngle(_axis, tilt)
      _quat.premultiply(_tiltQuat)
    }
    const s = placements.scale[i] as number
    _scale.set(s, s * (placements.squash[i] as number), s)
    _matrix.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _matrix)
    variant[i] = placements.variant[i] as number
  }
  mesh.instanceMatrix.needsUpdate = true
  geometry.setAttribute('iVariant', new THREE.InstancedBufferAttribute(variant, 1))
  // Linear RGB straight from the placement pass — the ground's own colour mixed
  // with the palette's, in the same space `render/terrain-mesh.ts` writes the
  // terrain's vertex colours in.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(placements.color, 3)

  return {
    object: mesh,
    instances: placements.count,
    triangles: placements.count * (variants[0] as PropMesh).triangleCount,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

// ── Flocks ────────────────────────────────────────────────────────────────

const FLAP_HOOK = '#include <begin_vertex>'

/**
 * The beat.
 *
 * `abs(x)` so both wings sweep the same way — a bird, not a pair of scissors —
 * and `x *= cos(a)` so the span shortens as they rise, which is what a wing
 * does and what stops the silhouette stretching.
 */
const FLAP_GLSL = `
  {
    float a = uWingSweep * sin(uWingTime + iPhase);
    transformed.y += abs(transformed.x) * sin(a);
    transformed.x *= cos(a);
  }
`

const FLAP_DECLS = `
attribute float iPhase;
uniform float uWingSweep;
uniform float uWingTime;
`

export interface FlockField {
  readonly object: THREE.InstancedMesh
  readonly instances: number
  /**
   * One frame, on the RENDER clock.
   *
   * Birds are ambience, never sim: nothing under `src/sim/` can see them, they
   * score nothing and they collide with nothing. `seconds` is the wall clock the
   * particles and the waves already run on, and `birdAt` is a pure function of
   * it — so a paused second costs the flock nothing and a dropped frame costs it
   * nothing either.
   */
  update(seconds: number): void
  dispose(): void
}

const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _up = new THREE.Vector3()
const _side = new THREE.Vector3()
const _centre = new THREE.Vector3()

/**
 * Every flock in the world, in one instanced mesh.
 *
 * One mesh and not one per flock, because §5's measure is draw calls and sixty
 * birds are sixty matrices a frame — nothing. The loops themselves are
 * placements from the pure layer; all this does is ask where each bird is.
 */
export const createFlockField = (
  bird: BirdMesh,
  flocks: readonly FlockPlacement[],
  applyFog?: (material: THREE.Material) => void,
  applyIllustrative?: (material: THREE.Material) => void,
): FlockField => {
  let total = 0
  for (const f of flocks) total += f.birds.length

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(bird.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(bird.normals, 3))

  const uniforms = {
    uWingSweep: { value: WING_SWEEP },
    uWingTime: { value: 0 },
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    // A bird banking past the canopy shows its underside, and a back-face-culled
    // two-triangle bird blinks out for half of every lap.
    side: THREE.DoubleSide,
  })
  applyFog?.(material)
  applyIllustrative?.(material)
  chainShaderPatch(material, {
    tag: 'dressing-flock',
    uniforms,
    vertex: (source) => `${FLAP_DECLS}${source}`.replace(FLAP_HOOK, `${FLAP_HOOK}${FLAP_GLSL}`),
  })

  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, total))
  mesh.name = 'dressing:birds'
  mesh.count = total
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false

  const phase = new Float32Array(Math.max(1, total))
  const color = new Float32Array(Math.max(1, total) * 3)
  let at = 0
  for (const f of flocks) {
    for (const b of f.birds) {
      phase[at] = b.wingPhase
      color[at * 3] = b.color[0]
      color[at * 3 + 1] = b.color[1]
      color[at * 3 + 2] = b.color[2]
      at++
    }
  }
  geometry.setAttribute('iPhase', new THREE.InstancedBufferAttribute(phase, 1))
  mesh.instanceColor = new THREE.InstancedBufferAttribute(color, 3)

  const pose = birdPose()

  return {
    object: mesh,
    instances: total,
    update(seconds: number): void {
      uniforms.uWingTime.value = seconds * WING_HZ * Math.PI * 2
      if (total === 0) return
      let i = 0
      for (const flock of flocks) {
        _centre.set(flock.centre[0], flock.centre[1], -flock.centre[2])
        for (const b of flock.birds) {
          birdAt(flock, b, seconds, pose)
          // Mesh space -> three, the same z flip the props take.
          _pos.set(pose.x, pose.y, -pose.z)
          _f.set(pose.dx, pose.dy, -pose.dz)
          // Up is across the tangent and the HORIZONTAL outward radius, so a
          // flat loop leaves its birds exactly level and a tilted one banks
          // them into the turn. `lookAt` is deliberately not used: two
          // conventions are live in this renderer at once (trap 22) and a basis
          // written out cannot be the wrong one.
          _r.subVectors(_pos, _centre)
          _r.y = 0
          if (_r.lengthSq() < 1e-8) _r.set(1, 0, 0)
          _r.normalize()
          _up.crossVectors(_f, _r)
          if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0)
          _up.normalize()
          _side.crossVectors(_up, _f).normalize()
          _matrix.makeBasis(_side, _up, _f)
          _matrix.scale(_scale.set(b.size, b.size, b.size))
          _matrix.setPosition(_pos)
          mesh.setMatrixAt(i, _matrix)
          i++
        }
      }
      mesh.instanceMatrix.needsUpdate = true
    },
    dispose(): void {
      geometry.dispose()
      material.dispose()
    },
  }
}
