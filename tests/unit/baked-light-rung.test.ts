// tests/unit/baked-light-rung.test.ts — DEV-237. Two rungs, one of them already
// measured.
//
// Matt has to choose between two pictures of the ground, and the choice is
// worthless if the arm he is choosing against has quietly moved underneath him.
// So the first block here is not about rung 1 at all: it is the proof that
// rung 3 still emits, byte for byte, the program DEV-232 measured at
// **-0.80 ms p50 / -1.15 p95** on `adv_02_jumpSeat`.
// `tests/unit/fixtures/baked-light-rung3.json` was captured by running
// 4562893's own `render/baked-light.ts`, before a line of DEV-237 existed.
//
// The rest is the property that makes rung 3's stability provable in general:
// **the emitted GLSL is a pure function of `material.defines`**, which is the
// state three already hashes into the program cache key. Every other gate in
// this renderer emits both branches and lets the preprocessor choose; this one
// cannot, because emitting rung 1's branch unconditionally would change rung 3's
// TEXT. Reading the rung off the defines at compile time is what stops the text
// and the key drifting apart — and drifting apart is precisely the DEV-194
// hazard this arrangement would otherwise be a textbook instance of.
//
// Where a claim is about three's own source, it is READ out of three's build
// rather than remembered (`xr-eye-layers.test.ts`'s discipline): `three` is
// pinned exact, and these are its private strings, not its API.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { BAKED_LIGHT_RUNGS, type Edition, validateEdition } from '@/content/edition-schema'
import {
  attachEditionBakedLight,
  BAKED_LIGHT_DEFINE,
  BAKED_RUNG1_DEFINE,
  bakedLightPatchFragment,
  bakedRungOf,
  createBakedLight,
  installBakedLight,
  OUTGOING_ANCHORS,
  SHADOW_ONLY_GLSL,
  setBakedLight,
} from '@/render/baked-light'
import { SUN_HEIGHT_GLSL, sunHeightChunk } from '@/render/far-shadow'

/** What 4562893 emitted, captured by running that tree's own module. */
const GOLDEN = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), 'tests', 'unit', 'fixtures', 'baked-light-rung3.json'),
    'utf8',
  ),
) as {
  three: string
  physical: string
  lambert: string
  cacheKeyTail: string
  defines: string[]
}

const RUNG3_WRITE = 'vec3 outgoingLight = diffuseColor.rgb + totalEmissiveRadiance;'
const RUNG1_WRITE =
  'vec3 outgoingLight = diffuseColor.rgb * ff2ShadowOnly() + totalEmissiveRadiance;'

const rung1 = (): string => bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader, 1)

/** Run a material's installed patch chain and hand back the fragment shader. */
const compile = (m: THREE.Material): string => {
  const shader = { fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} }
  m.onBeforeCompile(shader as never, null as never)
  return shader.fragmentShader
}

// ─────────────────────────────────────────────────────────────────────────

describe('DEV-237 — rung 3 is still the build DEV-232 measured', () => {
  it('the fixture is a real capture and not an empty file', () => {
    // The loud counterpart. A golden that rotted to `""` would make every
    // assertion below vacuously true for ever, which is exactly how a guarded
    // suite stays green while guarding nothing.
    expect(GOLDEN.physical.length).toBeGreaterThan(2000)
    expect(GOLDEN.lambert.length).toBeGreaterThan(1000)
    expect(GOLDEN.physical).toContain(`#ifdef ${BAKED_LIGHT_DEFINE}`)
    expect(GOLDEN.physical).toContain(RUNG3_WRITE)
    // And it was captured against the three this build pins.
    expect(String(GOLDEN.three)).toBe(String(THREE.REVISION))
  })

  it('emits the physical fragment shader byte for byte as 4562893 did', () => {
    // THE assertion of this file. A diff here means DEV-232's -0.80 ms was
    // taken on a program this build no longer compiles, and the two rungs are
    // then being compared against different baselines.
    expect(bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader)).toBe(GOLDEN.physical)
  })

  it('emits the lambert fragment shader byte for byte as 4562893 did', () => {
    // `?terrainLit=lambert` (DEV-182) is a different material class with a
    // different anchor, and a rung that kept its promise on only one of them
    // would be a promise about half the ladder.
    expect(bakedLightPatchFragment(THREE.ShaderLib.lambert.fragmentShader)).toBe(GOLDEN.lambert)
  })

  it('contributes the same cache-key tail, and the same defines', () => {
    // The TAIL and not the whole key. three's default
    // `customProgramCacheKey()` is `onBeforeCompile.toString()`, so editing the
    // patch function's BODY renames every key that carries it. That rename is
    // inert — every terrain material in a run carries the same patch, so it
    // splits nothing from anything — and it is not what this is about. What
    // this module CONTRIBUTES is, and at rung 3 it must contribute what it did.
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0 })
    installBakedLight(m)
    setBakedLight(m, true)
    const tail = m.customProgramCacheKey().slice(m.onBeforeCompile.toString().length)
    expect(tail).toBe(GOLDEN.cacheKeyTail)
    expect(Object.keys(m.defines ?? {})).toEqual(GOLDEN.defines)
  })

  it('with the flag OFF emits rung 3 text whatever rung was asked for', () => {
    // `setBakedLight(m, false, 1)` must not leave `FF2_BAKED_RUNG1` standing,
    // or an OFF arm would compile rung 1's text — branch unreachable, picture
    // identical, key different. The baseline of an A/B would then depend on
    // which treatment ran before it.
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    setBakedLight(m, true, 1)
    setBakedLight(m, false, 1)
    expect(Object.keys(m.defines ?? {})).not.toContain(BAKED_RUNG1_DEFINE)
    expect(compile(m)).toBe(GOLDEN.physical)
  })
})

describe('DEV-237 — rung 1 keeps the shadow multiply, PER FRAGMENT', () => {
  it('multiplies the baked albedo by a shadow term rather than writing it raw', () => {
    const patched = rung1()
    expect(patched).toContain(RUNG1_WRITE)
    // And it is not rung 3's statement: if the two ever converged the flag
    // would be one picture wearing two names.
    expect(patched).not.toContain(RUNG3_WRITE)
  })

  it('is still upstream of opaque_fragment, so the fog and the haze still run', () => {
    // DEV-232's own load-bearing assertion, restated for the new rung rather
    // than assumed to carry over. `unity-fog.ts` writes `outgoingLight`
    // immediately above `#include <opaque_fragment>`; a write below that hook
    // cannot be read by it, and a vanished fog looks like a plausible clear day.
    const patched = rung1()
    expect(patched.indexOf(RUNG1_WRITE)).toBeLessThan(patched.indexOf('#include <opaque_fragment>'))
  })

  it('samples the shadow map per fragment — a getShadow call, not a baked term', () => {
    // The whole point of the rung, and the thing rung 2 would take away. A
    // per-vertex shadow on an 8 m grid is not a shadow of a moving ship at all.
    expect(rung1()).toContain('getShadow( directionalShadowMap[ 0 ]')
  })

  it('declares ff2ShadowOnly ABOVE main and BELOW the pars that declare its parts', () => {
    // An ORDERING rather than a line number, so it is true however three
    // renumbers. The helper calls `getShadow` and reads `receiveShadow`,
    // `directionalShadowMap`, `vDirectionalShadowCoord` and
    // `directionalLightShadows`, every one of which three declares in a
    // `*_pars_fragment` chunk above `void main()`.
    const patched = rung1()
    const helper = patched.indexOf('float ff2ShadowOnly()')
    expect(helper).toBeGreaterThan(-1)
    expect(helper).toBeGreaterThan(patched.indexOf('#include <shadowmap_pars_fragment>'))
    expect(helper).toBeGreaterThan(patched.indexOf('#include <lights_pars_begin>'))
    expect(helper).toBeLessThan(patched.indexOf('void main() {'))
  })

  it('and three really does declare every one of them up there — read, not remembered', () => {
    // If a release moves any of these below `main`, rung 1 stops compiling.
    // This says which one, in CI, rather than leaving a black island for
    // somebody wearing a headset to find.
    const head = THREE.ShaderLib.physical.fragmentShader.split('void main() {')[0] as string
    expect(head).toContain('#include <lights_pars_begin>')
    expect(head).toContain('#include <shadowmap_pars_fragment>')
    expect(THREE.ShaderChunk.lights_pars_begin).toContain('uniform bool receiveShadow;')
    for (const name of [
      'float getShadow(',
      'directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ]',
      'vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ]',
      'directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ]',
    ]) {
      expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain(name)
    }
  })

  it('drops directLight.visible because three assigns it a literal true', () => {
    // The one term of three's statement rung 1 does NOT restate, and the reason
    // is in three's source rather than in our memory: `getDirectionalLightInfo`
    // sets `light.visible = true` unconditionally, so `( directLight.visible &&
    // receiveShadow )` is `receiveShadow`. If a release ever makes it
    // conditional, rung 1 needs the term back and this is what says so.
    const chunk = THREE.ShaderChunk.lights_pars_begin
    const fn = chunk.slice(chunk.indexOf('void getDirectionalLightInfo'))
    expect(fn.slice(0, fn.indexOf('}'))).toContain('light.visible = true;')
    // `receiveShadow` is NOT dropped: it is a real per-object uniform and a
    // chunk that does not receive must not be darkened by the ship above it.
    expect(SHADOW_ONLY_GLSL).toContain('receiveShadow ?')
  })

  it('composes with far-shadow by MIN, which is what far-shadow itself writes', () => {
    // Compared against something OUTSIDE this module (DEV-069: a test that
    // compares two of your own devices has tested neither). The static
    // sun-height shadow and the dynamic shadow map are two shadows of ONE sun,
    // so they compose by whichever is darker. far-shadow's splice is
    // `min( getShadow(...), ff2SunHeightTerm() )` and rung 1 has to agree with
    // it, or the same fragment is darker in one arm than in the other for a
    // reason that has nothing to do with the rung.
    expect(sunHeightChunk()).toContain('min(')
    expect(sunHeightChunk()).toContain('ff2SunHeightTerm()')
    expect(SHADOW_ONLY_GLSL).toContain('min( s, ff2SunHeightTerm() )')
    // Guarded on the define far-shadow prepends for exactly this use — its own
    // header: "so a material's OWN sun term can take the same shadow under
    // #ifdef rather than guessing whether the function exists".
    expect(SUN_HEIGHT_GLSL).toContain('#define FF2_SUN_HEIGHT 1')
    expect(SUN_HEIGHT_GLSL).toContain('float ff2SunHeightTerm()')
    expect(SHADOW_ONLY_GLSL).toContain('#ifdef FF2_SUN_HEIGHT')
  })

  it('still deletes the view-dependent half — the helper touches no view vector', () => {
    // Rung 1 is not "rung 0 with a define". It keeps the shadow and nothing
    // else; anything reading the eye would put the GGX lobe or a PMREM fetch
    // back, and the prize with it.
    for (const viewy of ['geometryViewDir', 'vViewPosition', 'getIBLRadiance', 'BRDF_GGX']) {
      expect(SHADOW_ONLY_GLSL).not.toContain(viewy)
    }
  })

  it('throws rather than emitting a helper it cannot place', () => {
    // Same reason as every other throw in this family: the failure is silent by
    // nature. A rung-1 write with no `ff2ShadowOnly` above it does not fail in
    // TypeScript — it fails in a driver, in a headset, as a black island.
    expect(() => bakedLightPatchFragment(`${OUTGOING_ANCHORS[0]}\nno main here`, 1)).toThrow(
      /ff2ShadowOnly/,
    )
  })
})

describe('DEV-237 — two rungs are two programs, and the text follows the defines', () => {
  it('gives the two rungs different cache keys', () => {
    // If they hashed alike, whichever compiled first would win for both and the
    // A/B would photograph one rung twice — `render/program-cache-key.ts`'s
    // original bug, in a new place.
    const a = new THREE.MeshStandardMaterial()
    const b = new THREE.MeshStandardMaterial()
    installBakedLight(a)
    installBakedLight(b)
    setBakedLight(a, true, 3)
    setBakedLight(b, true, 1)
    expect(b.customProgramCacheKey()).not.toBe(a.customProgramCacheKey())
    // Two mechanisms, both deliberate: the define (three hashes `defines`) and
    // the tag. Either alone would do it; the pair is what makes the claim true
    // of THIS file's code rather than only of three's internals.
    expect(Object.keys(b.defines ?? {})).toContain(BAKED_RUNG1_DEFINE)
    expect(b.customProgramCacheKey()).toContain('rung1')
    expect(a.customProgramCacheKey()).not.toContain('rung1')
  })

  it('compiles the text the DEFINES ask for, not the text install time asked for', () => {
    // The property that makes the whole arrangement safe. One material, one
    // installed patch, and the emitted GLSL changes because the define changed
    // — so the key three hashes and the text three compiles can never be about
    // two different rungs.
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    setBakedLight(m, true, 3)
    expect(compile(m)).not.toContain('ff2ShadowOnly')
    expect(bakedRungOf(m)).toBe(3)
    setBakedLight(m, true, 1)
    expect(bakedRungOf(m)).toBe(1)
    expect(compile(m)).toContain(RUNG1_WRITE)
    setBakedLight(m, true, 3)
    expect(compile(m)).toBe(GOLDEN.physical)
  })

  it('never leaves the rung define standing without the light define', () => {
    // `bakedRungOf` treats anything that is not rung 1 as rung 3, which is
    // right at the shader — an unrecognised rung must not invent a fourth
    // picture — and would be a lie at the report. What keeps it honest is that
    // the pair is only ever written together.
    const m = new THREE.MeshStandardMaterial()
    for (const [on, rung] of [
      [true, 1],
      [true, 3],
      [false, 1],
      [false, 3],
      [true, 1],
      [false, 1],
    ] as const) {
      setBakedLight(m, on, rung)
      const names = Object.keys(m.defines ?? {})
      if (names.includes(BAKED_RUNG1_DEFINE)) expect(names).toContain(BAKED_LIGHT_DEFINE)
    }
  })

  it('writes the two defines in ONE insertion order by every route (DEV-194)', () => {
    // three walks `material.defines` with `for ( const name in … )`, so `{A,B}`
    // and `{B,A}` are two keys for one shader — and a key that MOVES makes the
    // program a function of the run's HISTORY rather than of its state. The
    // ocean paid 318 ms mid-flight for exactly that.
    //
    // Asserted as agreement BETWEEN ROUTES as well as against the order itself,
    // so the property survives someone deliberately changing the order.
    // Filtered to this module's two names, and their ORDER within the whole —
    // `MeshStandardMaterial` is born carrying `STANDARD`, and three's own
    // `Material.copy` resets `defines` to exactly that, so the prefix is not
    // ours to assert about. What is ours is that these two always arrive at the
    // tail, in one order, by every route.
    const order = (steps: readonly (readonly [boolean, 1 | 3])[]): string[] => {
      const m = new THREE.MeshStandardMaterial()
      for (const [on, rung] of steps) setBakedLight(m, on, rung)
      const names = Object.keys(m.defines ?? {})
      // They are at the TAIL, which is the half that makes the order stable.
      const ours = names.filter((n) => n === BAKED_LIGHT_DEFINE || n === BAKED_RUNG1_DEFINE)
      expect(names.slice(names.length - ours.length)).toEqual(ours)
      return ours
    }
    const straight = order([[true, 1]])
    expect(straight).toEqual([BAKED_LIGHT_DEFINE, BAKED_RUNG1_DEFINE])
    // Every road to (on, rung 1) lands on the same two keys in the same order.
    expect(
      order([
        [true, 3],
        [true, 1],
      ]),
    ).toEqual(straight)
    expect(
      order([
        [true, 1],
        [true, 3],
        [true, 1],
      ]),
    ).toEqual(straight)
    expect(
      order([
        [true, 1],
        [false, 1],
        [true, 1],
      ]),
    ).toEqual(straight)
    expect(
      order([
        [false, 3],
        [true, 1],
        [true, 3],
        [false, 3],
        [true, 1],
      ]),
    ).toEqual(straight)
    // ...and so does every road back to (on, rung 3).
    const back = order([[true, 3]])
    expect(back).toEqual([BAKED_LIGHT_DEFINE])
    expect(
      order([
        [true, 1],
        [true, 3],
      ]),
    ).toEqual(back)
    expect(
      order([
        [true, 1],
        [false, 3],
        [true, 3],
      ]),
    ).toEqual(back)
  })

  it('moves only on a real change, so re-stating an arm does not re-fetch a program', () => {
    // `needsUpdate` drops the material's program reference, so a sweep that
    // sets the same arm twice must not pay for it twice or the second reading
    // is measuring a compile.
    const m = new THREE.MeshStandardMaterial()
    expect(setBakedLight(m, true, 1)).toBe(true)
    expect(setBakedLight(m, true, 1)).toBe(false)
    expect(setBakedLight(m, true, 3)).toBe(true)
    expect(setBakedLight(m, true, 3)).toBe(false)
  })
})

describe('DEV-237 — the report says which rung, and reads it back off the materials', () => {
  const world = () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.DirectionalLight(0xffffff, 1))
    const root = new THREE.Group()
    scene.add(root)
    const material = new THREE.MeshStandardMaterial()
    const baked = createBakedLight()
    baked.applyTo(material)
    baked.addRoot(root)
    const g = new THREE.BufferGeometry()
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from([0.5, 0.4, 0.3]), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from([0, 1, 0]), 3))
    root.add(new THREE.Mesh(g, material))
    baked.offer(g)
    return { scene, material, baked }
  }

  it('defaults to rung 3 — the rung DEV-232 measured', () => {
    expect(createBakedLight().report().rung).toBe(3)
  })

  it('pushes the rung to the material and NAMES the defines it pushed', () => {
    // The mechanism check, as something a harness can print rather than
    // something a document asks it to remember. DEV-232 §10c: a warning in a
    // 60-second run scrolls past and the artifact afterwards looks exactly like
    // a real reading.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung(1)
    const r = w.baked.refresh(w.scene)
    expect(r.on).toBe(true)
    expect(r.rung).toBe(1)
    expect(r.liveRung).toBe(1)
    expect(r.defines).toEqual([BAKED_LIGHT_DEFINE, BAKED_RUNG1_DEFINE])
  })

  it('reads liveRung BACK rather than echoing the intent', () => {
    // The distinction that voided DEV-232's first A/B: a report that mirrors
    // what it was told cannot see an intent that reached nothing. Here the
    // intent moves and is never pushed, and the report says so.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.refresh(w.scene)
    expect(w.baked.report().liveRung).toBe(3)
    w.baked.setRung(1)
    // No refresh. The ASK moved; the MATERIAL did not.
    expect(w.baked.report().rung).toBe(1)
    expect(w.baked.report().liveRung).toBe(3)
    w.baked.refresh(w.scene)
    expect(w.baked.report().liveRung).toBe(1)
  })

  it('reports no defines at all when the flag is off, so an arm that did not fire is loud', () => {
    const w = world()
    w.baked.setRung(1)
    const r = w.baked.refresh(w.scene)
    expect(r.on).toBe(false)
    // `reason` is null when nothing asked — it answers "why is this not on
    // although you wanted it", and nobody wanted it. `wanted` is the field that
    // says so, which is the separation DEV-232 §10c added.
    expect(r.wanted).toBe(false)
    expect(r.reason).toBeNull()
    expect(r.defines).toEqual([])
    expect(r.liveRung).toBe(3)
  })
})

describe('DEV-237 — the preset is the route a player can reach', () => {
  const editionLike = (enabled: boolean, rung: 1 | 3) => ({
    current: { terrain: { bakedLight: { enabled, rung } } },
    subscribe: () => () => {},
  })

  const spy = () => {
    const seen: { on?: boolean; rung?: number } = {}
    return {
      seen,
      target: {
        setEnabled: (on: boolean) => {
          seen.on = on
        },
        setRung: (r: 1 | 3) => {
          seen.rung = r
        },
      },
    }
  }

  it('takes BOTH halves of the intent off the preset', () => {
    const s = spy()
    attachEditionBakedLight(s.target, editionLike(true, 1), () => {})
    expect(s.seen).toEqual({ on: true, rung: 1 })
  })

  it('lets ?bakedRung= pin the rung over the preset, because VRTO3D_FLAGS_ON cannot reach it', () => {
    // `xr-vrto3d-trace.spec.ts`'s flip is `block[b] = { ...target, enabled }` —
    // it spreads every other field of the block straight through from the
    // preset, deliberately, because a flag path is two segments and a third
    // would switch off the wrong block. So the FLAG says *bake* and the PIN
    // says *which rung*, and the coordinator's two arms are two loads that
    // differ by one query parameter rather than by a build.
    const s = spy()
    attachEditionBakedLight(s.target, editionLike(true, 3), () => {}, 1)
    // The flag still comes from the preset; only the rung is pinned.
    expect(s.seen).toEqual({ on: true, rung: 1 })
  })

  it('leaves the rung to the preset when nothing is pinned', () => {
    const s = spy()
    attachEditionBakedLight(s.target, editionLike(false, 3), () => {}, null)
    expect(s.seen).toEqual({ on: false, rung: 3 })
  })
})

describe('DEV-237 — the preset carries a rung and the validator refuses a wrong one', () => {
  const read = (id: string): Edition =>
    JSON.parse(fs.readFileSync(path.join('content', 'editions', `${id}.json`), 'utf8')) as Edition

  it('ships rung 3 in BOTH presets, with the flag off', () => {
    // 3 is the value that reproduces the build DEV-232 measured. Shipping
    // anything else would make the flag a different feature the day somebody
    // flips it, and nothing else in the tree would say so.
    for (const id of ['anniversary', 'classic']) {
      const b = read(id).terrain.bakedLight
      expect(b.enabled).toBe(false)
      expect(b.rung).toBe(3)
    }
  })

  it('accepts every rung the list names', () => {
    // The list and the validator agree, asserted as a relationship rather than
    // by writing the same two numbers out twice (trap 24).
    for (const rung of BAKED_LIGHT_RUNGS) {
      const e = read('anniversary')
      const patched = {
        ...e,
        terrain: { ...e.terrain, bakedLight: { ...e.terrain.bakedLight, rung } },
      } as Edition
      expect(validateEdition(patched).terrain.bakedLight.rung).toBe(rung)
    }
  })

  it('refuses a rung that is not on it — including the rung that is NOT BUILT', () => {
    // 2 is the interesting one. The plan HAS a rung 2 (rung 1 with
    // `ff2SunHeightTerm` baked as well) and this port does not: baking it puts
    // the static shadow terminator back on the 8 m grid that far-shadow's
    // SIGNED field exists to get it off. A preset asking for 2 would silently
    // get rung 3's picture through `bakedRungOf`'s fallback, and an arm would
    // print a millisecond for a rung nobody wrote.
    const e = read('anniversary')
    for (const bad of [0, 2, 4, -1, Number.NaN]) {
      const patched = {
        ...e,
        terrain: { ...e.terrain, bakedLight: { ...e.terrain.bakedLight, rung: bad } },
      } as unknown as Edition
      expect(() => validateEdition(patched)).toThrow(/bakedLight\.rung/)
    }
  })
})
