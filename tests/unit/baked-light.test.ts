// tests/unit/baked-light.test.ts — DEV-232.
//
// Three failures this file exists to make impossible, in the order they would
// cost the most:
//
//  1. **The gate lands where `FF2_UNLIT` lands and deletes the fog with it.**
//     That is the whole reason DEV-232 has its own anchor rather than reusing
//     the one `render/fragment-gates.ts` already ships: `scene.fog` is null in
//     this app, the real fog is `unity-fog.ts` writing `outgoingLight`
//     immediately above `#include <opaque_fragment>`, and a gate that ignores
//     `outgoingLight` takes the fog and the aerial haze with the lighting. The
//     assertion for it is a RELATIONSHIP — the baked write is upstream of
//     `opaque_fragment` in the patched text — which is true independently of
//     what anybody believed the anchor was.
//  2. **The bake is not actually per-face-constant**, so the thing the whole
//     proposal rests on quietly stops being true. The assertion is again a
//     relationship rather than a value: the factor a vertex gets depends on its
//     NORMAL and on nothing else, so three vertices of one face get the same
//     one and no albedo can change it.
//  3. **three's own text moves under us.** The anchors and the spherical-
//     harmonic weights are three's private strings and numbers, not API, and
//     `three` is pinned exact only until `three-mesh-bvh`'s ceiling is
//     accepted. So they are read out of three's build here rather than trusted
//     — `xr-eye-layers.test.ts`'s discipline, for its reason.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  BAKED_LIGHT_DEFINE,
  type BakedLightModel,
  bakedFactor,
  bakedLightModelOf,
  bakedLightPatchFragment,
  bakeVertexColours,
  createBakedLight,
  hasBakedLight,
  installBakedLight,
  OUTGOING_ANCHORS,
  SH_BANDS,
  setBakedLight,
} from '@/render/baked-light'

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1

const BAKED_WRITE = 'vec3 outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;'

const model = (over: Partial<BakedLightModel> = {}): BakedLightModel => ({
  // Straight down the +y axis, i.e. a sun overhead.
  sunToward: [0, 1, 0],
  sunColor: [3, 2, 1],
  probe: Array.from({ length: 9 }, () => [0, 0, 0] as [number, number, number]),
  ...over,
})

// ─────────────────────────────────────────────────────────────────────────

describe('baked light — three is the oracle, not our memory', () => {
  it('finds each anchor exactly once in the shader three actually ships', () => {
    // If either of these ever fails, the patch below would either throw at
    // compile time (visible) or splice into a line three no longer evaluates
    // (invisible). This is the half that catches it in CI instead.
    expect(count(THREE.ShaderLib.physical.fragmentShader, OUTGOING_ANCHORS[0])).toBe(1)
    expect(count(THREE.ShaderLib.lambert.fragmentShader, OUTGOING_ANCHORS[1])).toBe(1)
  })

  it('uses three own spherical-harmonic weights', () => {
    // `shGetIrradianceAt` is three's; `SH_BANDS` is a transcription of its six
    // distinct constants. Assert each one is still in the GLSL rather than
    // re-deriving the irradiance the way the implementation does (trap 24) —
    // a three upgrade that retunes a band then fails here rather than shifting
    // every ambient in the game by a few percent in silence.
    const glsl = THREE.ShaderChunk.lights_pars_begin
    expect(glsl).toContain('shGetIrradianceAt(')
    expect(glsl).toContain('0.886227')
    expect(glsl).toContain('0.511664')
    expect(glsl).toContain('0.743125')
    expect(glsl).toContain('0.247708')
    expect(glsl).toContain('0.429043')
    // And the transcription agrees with them, so the list above is not decoration.
    expect(SH_BANDS[0]).toBeCloseTo(0.886227, 6)
    expect(SH_BANDS[1]).toBeCloseTo(2 * 0.511664, 6)
    expect(SH_BANDS[2]).toBeCloseTo(0.743125, 6)
    expect(SH_BANDS[3]).toBeCloseTo(0.247708, 6)
    expect(SH_BANDS[4]).toBeCloseTo(2 * 0.429043, 6)
    expect(SH_BANDS[5]).toBeCloseTo(0.429043, 6)
  })
})

describe('baked light — the anchor is upstream of the fog, which is the point', () => {
  it('puts the baked write ABOVE opaque_fragment, where unity-fog still runs', () => {
    // THE assertion of this file. `render/unity-fog.ts` injects the haze and
    // Lengyel's half-space mix immediately before `#include <opaque_fragment>`,
    // both writing `outgoingLight`. A gate downstream of that hook cannot be
    // read by them; a gate upstream of it can. Stated as an ordering, so it is
    // true whatever either file's anchor string happens to be.
    const patched = bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader)
    const write = patched.indexOf(BAKED_WRITE)
    const hook = patched.indexOf('#include <opaque_fragment>')
    expect(write).toBeGreaterThan(-1)
    expect(hook).toBeGreaterThan(-1)
    expect(write).toBeLessThan(hook)
  })

  it('is NOT the gate fragment-gates already ships', () => {
    // `FF2_UNLIT` rewrites the statement INSIDE `opaque_fragment`, downstream
    // of the fog. If these two ever collapsed into one anchor the A/B would be
    // measuring the fog as well as the lighting, and the number would be a
    // ceiling wearing an estimate's clothes.
    const patched = bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader)
    expect(patched).not.toContain('gl_FragColor = vec4( diffuseColor.rgb, 1.0 );')
  })
})

describe('baked light — the patch', () => {
  it('leaves three own statement in place when the define is absent', () => {
    const patched = bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader)
    expect(patched).toContain(OUTGOING_ANCHORS[0])
    expect(patched).toContain(`#ifdef ${BAKED_LIGHT_DEFINE}`)
    expect(patched).toContain('#else')
    expect(patched).toContain(BAKED_WRITE)
  })

  it('patches the Lambert rung too, on its own line', () => {
    const patched = bakedLightPatchFragment(THREE.ShaderLib.lambert.fragmentShader)
    expect(patched).toContain(OUTGOING_ANCHORS[1])
    expect(patched).toContain(BAKED_WRITE)
  })

  it('throws when no anchor is present rather than silently doing nothing', () => {
    // The failure mode this family of files keeps paying for: the shader still
    // compiles, the frame still renders, and the gate never fires (DEV-069).
    expect(() => bakedLightPatchFragment('void main() { gl_FragColor = vec4(1.0); }')).toThrow(
      /outgoingLight/,
    )
  })

  it('throws when an anchor appears twice', () => {
    const doubled = `${OUTGOING_ANCHORS[0]}\n${OUTGOING_ANCHORS[0]}`
    expect(() => bakedLightPatchFragment(doubled)).toThrow(/outgoingLight/)
  })
})

describe('baked light — install and flip', () => {
  it('tags the program cache key, because onBeforeCompile is not in it', () => {
    const m = new THREE.MeshStandardMaterial()
    const bare = m.customProgramCacheKey()
    installBakedLight(m)
    expect(m.customProgramCacheKey()).not.toBe(bare)
    expect(m.customProgramCacheKey()).toContain('baked-light')
  })

  it('is idempotent — installing twice does not chain the patch twice', () => {
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    const once = m.onBeforeCompile
    installBakedLight(m)
    expect(m.onBeforeCompile).toBe(once)
    expect(hasBakedLight(m)).toBe(true)
  })

  it('chains rather than replacing whatever was already there', () => {
    const m = new THREE.MeshStandardMaterial()
    const seen: string[] = []
    m.onBeforeCompile = () => seen.push('previous')
    installBakedLight(m)
    const shader = { fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} }
    m.onBeforeCompile(shader as never, null as never)
    expect(seen).toEqual(['previous'])
    expect(shader.fragmentShader).toContain(BAKED_LIGHT_DEFINE)
  })

  it('moves only on a real change, so a repeated arm does not re-fetch a program', () => {
    const m = new THREE.MeshStandardMaterial()
    expect(setBakedLight(m, true)).toBe(true)
    expect(setBakedLight(m, true)).toBe(false)
    expect(m.defines?.[BAKED_LIGHT_DEFINE]).toBe('')
    expect(setBakedLight(m, false)).toBe(true)
    expect(setBakedLight(m, false)).toBe(false)
    expect(Object.hasOwn(m.defines ?? {}, BAKED_LIGHT_DEFINE)).toBe(false)
  })
})

describe('baked light — the bake is per-face by construction', () => {
  it('gives two vertices with the same normal the same factor, whatever their colour', () => {
    // THE property the whole proposal rests on. `sim/terrain/faceted.ts` writes
    // one normal to all three vertices of a triangle, so if the factor is a
    // function of the normal alone then a per-vertex store of it is a copy of a
    // value that was already uniform over the polygon — lossless rather than a
    // resampling. Asserted as the RELATIONSHIP (the ratio is colour-independent)
    // rather than against a number this file computed the same way the code did.
    const m = model({
      probe: [[0.4, 0.5, 0.6], ...Array.from({ length: 8 }, () => [0, 0, 0])] as never,
    })
    const normals = Float32Array.from([0.3, 0.8, 0.5, 0.3, 0.8, 0.5])
    const dark = Float32Array.from([0.1, 0.2, 0.3, 0.1, 0.2, 0.3])
    const bright = Float32Array.from([0.9, 0.8, 0.7, 0.9, 0.8, 0.7])
    const a = bakeVertexColours(dark, normals, m, new Float32Array(6))
    const b = bakeVertexColours(bright, normals, m, new Float32Array(6))
    for (let i = 0; i < 6; i++) {
      // Same normal, same factor: the ratio out/in is identical across the two
      // vertices AND across the two albedos.
      //
      // Six places and not twelve, because the ratio is read back out of a
      // `Float32Array` — the attribute the GPU will read — and float32 carries
      // about seven significant digits. The residual here is 3e-9 on a value
      // near 0.88, which is storage and not arithmetic. A real violation of
      // this property is a different NORMAL, and that moves the ratio in the
      // second or third place, not the ninth.
      expect((a[i] as number) / (dark[i] as number)).toBeCloseTo(
        (b[i] as number) / (bright[i] as number),
        6,
      )
    }
    // ...and the two vertices of the face agree exactly.
    expect(a[0]).toBeCloseTo(a[3] as number, 12)
  })

  it('brightens a face turned toward the sun and not one turned away', () => {
    // A direction test with no number in it, so it cannot be satisfied by
    // reproducing the implementation's arithmetic.
    const m = model()
    const toward = bakedFactor(0, 1, 0, m, [0, 0, 0]).slice() as number[]
    const away = bakedFactor(0, -1, 0, m, [0, 0, 0]).slice() as number[]
    expect(toward[0]).toBeGreaterThan(away[0] as number)
    // Facing directly away from an overhead sun with no ambient is exactly
    // black — `saturate` gives zero, not a small number.
    expect(away[0]).toBe(0)
  })

  it('refuses mismatched buffers rather than reading past the end', () => {
    expect(() =>
      bakeVertexColours(new Float32Array(6), new Float32Array(3), model(), new Float32Array(6)),
    ).toThrow(/lengths disagree/)
  })
})

describe('baked light — reversible, scoped, and loud when it reaches nothing', () => {
  /** A terrain chunk's shape: vec3 colour, vec3 normal, one vertex. */
  const chunk = (): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from([0.5, 0.4, 0.3]), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from([0, 1, 0]), 3))
    return g
  }

  /**
   * A world: a lit scene, a root, a material, and `n` offered chunks in it.
   * Returns the pieces so a test can take one away.
   */
  const world = (n = 1) => {
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const root = new THREE.Group()
    scene.add(root)
    const material = new THREE.MeshStandardMaterial()
    const baked = createBakedLight()
    baked.applyTo(material)
    baked.addRoot(root)
    const geometries: THREE.BufferGeometry[] = []
    for (let i = 0; i < n; i++) {
      const g = chunk()
      geometries.push(g)
      root.add(new THREE.Mesh(g, material))
      baked.offer(g)
    }
    return { scene, root, material, baked, geometries }
  }

  const colours = (g: THREE.BufferGeometry): number[] =>
    Array.from(g.getAttribute('color').array as Float32Array)

  it('bakes what it was offered and restores it exactly when switched off', () => {
    const w = world()
    const g = w.geometries[0] as THREE.BufferGeometry
    const raw = colours(g)
    w.baked.setEnabled(true)
    expect(w.baked.refresh(w.scene).on).toBe(true)
    expect(colours(g)).not.toEqual(raw)
    w.baked.setEnabled(false)
    w.baked.refresh(w.scene)
    // Restored from the snapshot rather than by computing an inverse, so a
    // component that saturated cannot drift back to a different value.
    expect(colours(g)).toEqual(raw)
    expect(w.baked.report().baked).toBe(0)
  })

  it('baking twice is baking once', () => {
    const w = world()
    const g = w.geometries[0] as THREE.BufferGeometry
    w.baked.setEnabled(true)
    w.baked.refresh(w.scene)
    const after = colours(g)
    w.baked.refresh(w.scene)
    expect(colours(g)).toEqual(after)
    expect(w.baked.report().baked).toBe(1)
  })

  // ── THE SCOPE REGRESSION ────────────────────────────────────────────────

  it('LEAVES ALONE a mesh under its root that it was never offered', () => {
    // The defect this is for: `boot/app.ts` parents the SCATTER, the fracture
    // pieces and the V9 dressing under the LAND's own group — its comment says
    // *"they are parented under the terrain"*. The first version re-applied by
    // traversing that group and touching every mesh in it, so it reached the
    // props. Had they carried a vec3 colour it would have BAKED THE SCATTER,
    // which `docs/plan/DEV-232-BAKED-LIGHT.md` §2e proves is impossible:
    // `scatter.ts` draws a uniformly random yaw per instance and one
    // `InstancedMesh` shares one geometry, so every rock in the field would be
    // lit from its own private direction.
    const w = world()
    const prop = chunk()
    const before = colours(prop)
    w.root.add(new THREE.Mesh(prop, new THREE.MeshStandardMaterial()))
    w.baked.setEnabled(true)
    const report = w.baked.refresh(w.scene)
    expect(report.on).toBe(true)
    // The chunk moved...
    expect(colours(w.geometries[0] as THREE.BufferGeometry)).not.toEqual([0.5, 0.4, 0.3])
    // ...and the thing nobody offered did not.
    expect(colours(prop)).toEqual(before)
    expect(report.baked).toBe(1)
  })

  it('refuses a vec4 colour beside a vec3 normal rather than throwing on it', () => {
    // The exact crash the A/B hit, at the exact sizes:
    //
    //     baked-light: colour/normal/out lengths disagree (6384, 4788, 6384)
    //
    // 6384/4 = 4788/3 = 1596 — a glTF `COLOR_0` of vec4 on a 1596-vertex prop.
    // The first version compared ARRAY LENGTHS, which reads an ordinary mesh as
    // corrupt; counts are what agree. Nothing should reach this now that
    // `offer` does the scoping, so `refusals` is the check on that claim rather
    // than a tolerated condition.
    const n = 1596
    const g = new THREE.BufferGeometry()
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    expect(g.getAttribute('color').array.length).toBe(6384)
    expect(g.getAttribute('normal').array.length).toBe(4788)

    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const root = new THREE.Group()
    scene.add(root)
    root.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial()))
    const baked = createBakedLight()
    baked.applyTo(new THREE.MeshStandardMaterial())
    baked.addRoot(root)
    baked.offer(g) // deliberately offered, to exercise the guard itself
    baked.setEnabled(true)
    expect(() => baked.refresh(scene)).not.toThrow()
    expect(baked.report().refusals).toBe(1)
  })

  it('skips a geometry with colours but no normals rather than throwing', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const g = new THREE.BufferGeometry()
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from([1, 1, 1]), 3))
    const baked = createBakedLight()
    baked.offer(g)
    baked.setEnabled(true)
    expect(() => baked.refresh(scene)).not.toThrow()
  })

  // ── THE INTENT REGRESSION ───────────────────────────────────────────────

  it('KEEPS the intent through a refresh that reaches nothing, and lands on the next one', () => {
    // The defect this is for, and it is the one that voided the A/B. The first
    // version resolved the model at FLIP time and stored only the result, and
    // the refresh gated on `liveTerrain` — which `boot/app.ts` assigns 902
    // lines after the call that was meant to push the define. `VRTO3D_FLAGS_ON`
    // flips as soon as `__ff2.edition` exists, which is before the world is
    // built, so the flip landed on an empty world and nothing ever tried again:
    // no define, no error, and a program count identical in all three arms.
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const baked = createBakedLight()

    // The flip, before there is any terrain — exactly the A/B's ordering.
    baked.setEnabled(true)
    const early = baked.refresh(scene)
    expect(early.wanted).toBe(true)
    expect(early.on).toBe(false)
    expect(early.reason).toBe('no-terrain')

    // The world arrives.
    const root = new THREE.Group()
    scene.add(root)
    const material = new THREE.MeshStandardMaterial()
    baked.applyTo(material)
    baked.addRoot(root)
    const g = chunk()
    root.add(new THREE.Mesh(g, material))
    baked.offer(g)

    // ...and the SAME intent, never re-stated, now lands.
    const late = baked.refresh(scene)
    expect(late.wanted).toBe(true)
    expect(late.on).toBe(true)
    expect(late.reason).toBeNull()
    expect(material.defines?.[BAKED_LIGHT_DEFINE]).toBe('')
  })

  it('sets the define on the material, which is what moves the program count', () => {
    // The A/B's own tell: a define is in three's program cache key, so an arm
    // that sets one cannot leave the program count untouched. It did — so this
    // asserts the half that was missing.
    const w = world()
    expect(Object.hasOwn(w.material.defines ?? {}, BAKED_LIGHT_DEFINE)).toBe(false)
    w.baked.setEnabled(true)
    w.baked.refresh(w.scene)
    expect(w.material.defines?.[BAKED_LIGHT_DEFINE]).toBe('')
    w.baked.setEnabled(false)
    w.baked.refresh(w.scene)
    expect(Object.hasOwn(w.material.defines ?? {}, BAKED_LIGHT_DEFINE)).toBe(false)
  })

  it('says no-sun rather than going quietly off when the scene has no light', () => {
    const w = world()
    const sun = w.scene.children.find((c) => (c as THREE.DirectionalLight).isDirectionalLight)
    w.scene.remove(sun as THREE.Object3D)
    w.baked.setEnabled(true)
    const r = w.baked.refresh(w.scene)
    expect(r).toMatchObject({ wanted: true, on: false, reason: 'no-sun' })
  })

  it('reports not-wanted when nothing asked, which is not a failure', () => {
    const w = world()
    expect(w.baked.refresh(w.scene)).toMatchObject({
      wanted: false,
      on: false,
      reason: null,
    })
  })

  it('a streaming chunk offered while the bake is live arrives baked', () => {
    // A chunk that landed unbaked would draw raw albedo unlit for as long as it
    // was on screen — the mobile-toy ditch, in patches, moving at 180 m/s.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.refresh(w.scene)
    const late = chunk()
    const raw = colours(late)
    w.root.add(new THREE.Mesh(late, w.material))
    w.baked.offer(late)
    expect(colours(late)).not.toEqual(raw)
    expect(w.baked.report().baked).toBe(2)
  })

  it('reset drops the torn-down world so a mission swap does not hold it', () => {
    const w = world()
    w.baked.setEnabled(true)
    w.baked.refresh(w.scene)
    expect(w.baked.report().materials).toBe(1)
    w.baked.reset()
    const after = w.baked.report()
    expect(after.materials).toBe(0)
    expect(after.baked).toBe(0)
    // The intent is NOT reset — a teardown is not a decision about the preset.
    expect(after.wanted).toBe(true)
  })
})

describe('baked light — the model is read off the scene, not re-derived', () => {
  it('points sunToward AT the light, i.e. against the direction light travels', () => {
    // `boot/app.ts` builds the sun as `position = -direction * 10_000`, where
    // `direction` is where light TRAVELS. three's `getDirectionalLightInfo`
    // hands the shader `position - target`, so `sunToward` must be the negated
    // travel direction. Asserted as that relationship — a sign error here
    // lights every hillside from the wrong side and no value assertion written
    // from the same belief would catch it.
    const scene = new THREE.Scene()
    const travel = new THREE.Vector3(0.1, -0.7, 0.3).normalize()
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.copy(travel).multiplyScalar(-10_000)
    light.target.position.set(0, 0, 0)
    scene.add(light, light.target)
    const m = bakedLightModelOf(scene)
    expect(m).not.toBeNull()
    const toward = new THREE.Vector3(...(m as BakedLightModel).sunToward)
    expect(toward.dot(travel)).toBeCloseTo(-1, 6)
  })

  it('folds each probe intensity in, the way WebGLLights does', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const sh = new THREE.SphericalHarmonics3()
    ;(sh.coefficients[0] as THREE.Vector3).set(1, 2, 3)
    scene.add(new THREE.LightProbe(sh, 0.5))
    const m = bakedLightModelOf(scene) as BakedLightModel
    expect(m.probe[0]).toEqual([0.5, 1, 1.5])
  })

  it('sums two probes rather than taking the first', () => {
    // `WebGLLights` accumulates; taking one would quietly halve the ambient on
    // any scene that gained a second probe.
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    for (const v of [1, 3]) {
      const sh = new THREE.SphericalHarmonics3()
      ;(sh.coefficients[0] as THREE.Vector3).set(v, 0, 0)
      scene.add(new THREE.LightProbe(sh, 1))
    }
    const m = bakedLightModelOf(scene) as BakedLightModel
    expect((m.probe[0] as readonly number[])[0]).toBe(4)
  })

  it('returns null when there is no sun, so nothing bakes a black world', () => {
    expect(bakedLightModelOf(new THREE.Scene())).toBeNull()
  })

  it('scales the sun colour by its intensity, the way directLight.color is built', () => {
    const scene = new THREE.Scene()
    const light = new THREE.DirectionalLight(0xffffff, 4)
    light.color.setRGB(0.5, 0.25, 0.125, THREE.LinearSRGBColorSpace)
    scene.add(light, light.target)
    const m = bakedLightModelOf(scene) as BakedLightModel
    expect(m.sunColor).toEqual([2, 1, 0.5])
  })
})
