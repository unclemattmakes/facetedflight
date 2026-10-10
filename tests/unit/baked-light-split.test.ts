// tests/unit/baked-light-split.test.ts — DEV-240. The rung that shadows only
// what three shadows, and the cheaper rung that was considered and refused.
//
// DEV-237 photographed rung 1 at **33.9 mean levels of 255** darker than the
// shipped build into the sun and named the cause: three multiplies `getShadow`
// into `directLight.color` alone, so a bake that has collapsed the direct and
// the indirect into ONE vertex colour has nothing left to shadow half of. This
// file is the two halves of the fix — the arithmetic that chose the shape, and
// the mechanism that carries it.
//
// ── §1 is the candidate that was REFUSED, and it is a test on purpose ─────
//
// Two shapes were on the table. (a) two vec3 attributes, `ambient` and
// `direct`, and `ambient + direct * shadow`: exact, 12 bytes a vertex. (b) ONE
// float attribute holding `luminance(direct) / luminance(ambient + direct)`,
// and `colour * (1 - share * (1 - shadow))`: 4 bytes a vertex, and exact only
// where the sun and the ambient share a hue.
//
// **This game violates that condition by construction**, and a row already says
// so: `render/skyshop-ibl.ts` records that `ibl_sky`'s 27 baked floats were
// never re-baked after the sky was replaced, so *"the shipped game is lit by a
// near-neutral grey ambient under a warm sunset sky"*. A scalar share carries
// brightness and cannot carry hue, so under (b) a fully shadowed sun-facing
// slope keeps the SUNLIT hue instead of falling to the ambient's. Swept over
// the sphere of normals on all thirteen shipped missions, that is 7 to 45 mean
// levels of 255 — against a bar of about 2. (b) is refused, and the numbers are
// held here rather than in prose because a derived number needs an extracted
// one's provenance (CLAUDE.md, DEV-027).
//
// Where a claim is about three's own source it is READ out of three's build —
// the ACES curve, the `diffuse` uniform, the `color_vertex` hook and the
// binder's use of `defaultAttributeValues` — because `three` is pinned exact
// and these are its private strings, not its API (`xr-eye-layers.test.ts`).

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  BAKED_LIGHT_RUNGS,
  type BakedLightRung,
  type Edition,
  validateEdition,
} from '@/content/edition-schema'
import { TERRAIN } from '@/generated/constants.generated'
import {
  attachEditionBakedLight,
  BAKED_DEFINES,
  BAKED_LIGHT_DEFINE,
  BAKED_RUNG1_DEFINE,
  BAKED_SPLIT_DEFINE,
  type BakedLightModel,
  bakedFactor,
  bakedFactorSplit,
  bakedLightPatchFragment,
  bakedLightPatchVertex,
  bakedRungOf,
  bakeVertexColours,
  bakeVertexColoursSplit,
  createBakedLight,
  DIRECT_ATTRIBUTE,
  DIRECT_VARYING,
  installBakedLight,
  setBakedLight,
  shIrradiance,
} from '@/render/baked-light'
import { createSkyshopProbe, marmosetSunIntensity } from '@/render/skyshop-ibl'

// ─────────────────────────────────────────────────────────────────────────
// §0. The shipped missions' own light, rebuilt the way `boot/app.ts` builds it
// ─────────────────────────────────────────────────────────────────────────

/** Every shipped mission, from the generated tree rather than from a list. */
const MISSIONS = fs
  .readdirSync(path.join(process.cwd(), 'content', 'levels'))
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''))

interface LevelLike {
  readonly environment: string
  readonly lighting: {
    readonly sun: {
      readonly colorLinear: readonly number[]
      readonly intensity: number
      readonly direction: readonly number[]
    } | null
  }
}

/**
 * The model `bakedLightModelOf` would read off a scene built for this mission.
 *
 * Rebuilt from the level JSON and the sheet rather than from a scene because
 * this file is `environment: 'node'` and there is no renderer — but every step
 * is `boot/app.ts`'s, named: `marmosetSunIntensity` for the 2 pi,
 * `light.color * intensity` for the colour, the NEGATED travel direction for
 * `sunToward`, and `createSkyshopProbe(TERRAIN[env].ibl)` with its intensity
 * folded in the way `WebGLLights` folds it.
 */
const modelFor = (level: LevelLike): BakedLightModel | null => {
  const sun = level.lighting.sun
  if (!sun) return null
  const intensity = marmosetSunIntensity(sun.intensity)
  const ibl = (
    TERRAIN as unknown as Record<
      string,
      { ibl: Parameters<typeof createSkyshopProbe>[0] | null } | undefined
    >
  )[level.environment]?.ibl
  const probe: [number, number, number][] = Array.from({ length: 9 }, () => [0, 0, 0])
  if (ibl) {
    const p = createSkyshopProbe(ibl)
    for (let j = 0; j < 9; j++) {
      const c = p.sh.coefficients[j]
      if (!c) continue
      probe[j] = [c.x * p.intensity, c.y * p.intensity, c.z * p.intensity]
    }
  }
  const [dx, dy, dz] = sun.direction as [number, number, number]
  const length = Math.hypot(dx, dy, dz) || 1
  return {
    sunToward: [-dx / length, -dy / length, -dz / length],
    sunColor: [
      (sun.colorLinear[0] as number) * intensity,
      (sun.colorLinear[1] as number) * intensity,
      (sun.colorLinear[2] as number) * intensity,
    ],
    probe,
  }
}

const levelOf = (id: string): LevelLike =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'content', 'levels', `${id}.json`), 'utf8'),
  ) as LevelLike

// ─────────────────────────────────────────────────────────────────────────
// §0b. Display levels, on three's OWN curve
// ─────────────────────────────────────────────────────────────────────────
//
// "Mean levels of 255" is a quantity in DISPLAY space, after the tone curve and
// the sRGB transfer — which is what DEV-237's photographs measure and therefore
// the only space in which its 33.9 and this file's numbers are comparable. The
// Anniversary preset is `"toneMapping": "aces"` at exposure 1.
//
// The curve is PARSED out of `THREE.ShaderChunk.tonemapping_pars_fragment`
// rather than transcribed, so an upgrade that retunes ACES fails here instead
// of quietly moving every number below by a few levels.

const toneChunk = THREE.ShaderChunk.tonemapping_pars_fragment

/** The three numbers of one `vec3( … )` inside a named `mat3` in the chunk. */
const matrixColumns = (name: string): number[][] => {
  const at = toneChunk.indexOf(`const mat3 ${name} = mat3(`)
  if (at < 0) throw new Error(`three's tone chunk no longer declares ${name}`)
  const body = toneChunk.slice(at, toneChunk.indexOf(');', at))
  const columns = [...body.matchAll(/vec3\(([^)]*)\)/g)].map((m) =>
    (m[1] as string).split(',').map((s) => Number(s.trim())),
  )
  if (columns.length !== 3) throw new Error(`${name} no longer has three columns`)
  return columns
}

/** `m * v` for a GLSL mat3, whose constructor arguments are its COLUMNS. */
const mulColumns = (columns: number[][], v: readonly number[]): [number, number, number] => {
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const column = columns[c] as number[]
    for (let r = 0; r < 3; r++) {
      out[r] = (out[r] as number) + (column[r] as number) * (v[c] as number)
    }
  }
  return out
}

const ACES_IN = matrixColumns('ACESInputMat')
const ACES_OUT = matrixColumns('ACESOutputMat')

/** `RRTAndODTFit`, with its five coefficients read out of the same chunk. */
const RRT = (() => {
  const at = toneChunk.indexOf('vec3 RRTAndODTFit( vec3 v ) {')
  const body = toneChunk.slice(at, toneChunk.indexOf('return a / b;', at))
  const numbers = [...body.matchAll(/[-+]?\d*\.\d+/g)].map((m) => Number(m[0]))
  if (numbers.length !== 5) throw new Error('three RRTAndODTFit no longer has five coefficients')
  return numbers as [number, number, number, number, number]
})()

const rrt = (v: number): number => {
  const [k0, k1, k2, k3, k4] = RRT
  return (v * (v + k0) - k1) / (v * (k2 * v + k3) + k4)
}

/** Linear rgb -> display levels of 255, through ACES at exposure 1 then sRGB. */
const displayLevels = (linear: readonly number[]): [number, number, number] => {
  const scaled = linear.map((x) => x / 0.6)
  const fitted = mulColumns(ACES_IN, scaled).map(rrt)
  const out = mulColumns(ACES_OUT, fitted)
  return out.map((x) => {
    const c = Math.max(0, Math.min(1, x))
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
    return 255 * s
  }) as [number, number, number]
}

/** Rec.709 luminance — the weighting candidate (b)'s one float would use. */
const luminance = (c: readonly number[]): number =>
  0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)

/**
 * The worst display-space disagreement between the EXACT split and candidate
 * (b)'s scalar share, over the sphere of normals and over a range of albedos.
 *
 * At shadow `s` the two forms are `A + D*s` and `(A + D) * (1 - share*(1-s))`,
 * whose difference is `(1-s) * [ D_c - (A_c+D_c)*share ]` per channel — zero at
 * `s = 1` and largest in full shadow, which is where the whole feature lives.
 */
const worstShareError = (model: BakedLightModel, albedos: readonly number[]): number => {
  let worst = 0
  const ambient: [number, number, number] = [0, 0, 0]
  const direct: [number, number, number] = [0, 0, 0]
  const N = 120
  for (let a = 0; a <= N; a++) {
    const theta = (a / N) * Math.PI
    for (let b = 0; b < 2 * N; b++) {
      const phi = (b / (2 * N)) * 2 * Math.PI
      const nx = Math.sin(theta) * Math.cos(phi)
      const ny = Math.cos(theta)
      const nz = Math.sin(theta) * Math.sin(phi)
      bakedFactorSplit(nx, ny, nz, model, ambient, direct)
      const total = [0, 1, 2].map((k) => (ambient[k] as number) + (direct[k] as number))
      const share = luminance(total) > 0 ? luminance(direct) / luminance(total) : 0
      const approx = total.map((t) => t * (1 - share))
      for (const albedo of albedos) {
        const exact = displayLevels(ambient.map((x) => x * albedo))
        const got = displayLevels(approx.map((x) => x * albedo))
        for (let k = 0; k < 3; k++) {
          worst = Math.max(worst, Math.abs((exact[k] as number) - (got[k] as number)))
        }
      }
    }
  }
  return worst
}

// ─────────────────────────────────────────────────────────────────────────
// §1. The candidate that was refused
// ─────────────────────────────────────────────────────────────────────────

describe('DEV-240 §1 — one float cannot carry the split, and the data says why', () => {
  it('the shipped sun and the shipped ambient do not share a hue, on any mission', () => {
    // The MECHANISM, checked against the shipped data rather than inferred
    // from the error: candidate (b) is exact only where the direct and the
    // indirect have the same colour, and `render/skyshop-ibl.ts` records that
    // this game ships a near-neutral grey ambient under a warm sunset sky
    // because the 27 baked SH floats were never re-baked.
    const seen: string[] = []
    for (const id of MISSIONS) {
      const model = modelFor(levelOf(id))
      if (!model) continue
      // The sun, as a blue-over-red ratio.
      const sun = (model.sunColor[2] as number) / (model.sunColor[0] as number)
      // The ambient at an up-facing normal, the same way.
      const up: [number, number, number] = [0, 0, 0]
      shIrradiance(0, 1, 0, model.probe, up)
      const ambient = up[2] / up[0]
      seen.push(`${id} sun b/r ${sun.toFixed(3)} · ambient b/r ${ambient.toFixed(3)}`)
      // The RELATIONSHIP, not two absolute thresholds: what candidate (b)
      // needs is that the two halves share a hue, and what is true is that the
      // ambient is markedly bluer than the sun on every one of them. Asserting
      // the ratio says exactly the thing the decision rests on, and says it in
      // a form that is true whatever a future re-bake does to the absolute
      // levels (CLAUDE.md trap 24 — assert the relationship, not the value).
      expect(
        ambient / sun,
        `${id}: the ambient is not bluer than the sun\n${seen.join('\n')}`,
      ).toBeGreaterThan(1.25)
    }
    expect(seen.length).toBe(MISSIONS.length)
  })

  it('costs 7 to 45 display levels on EVERY shipped mission, so it is refused', () => {
    // The bar the brief set was ~2 levels — rung 3's own distance from the
    // shipped picture. Nothing comes close, at any albedo a terrain facet can
    // have, so the 4-byte form never gets as far as being a trade.
    const report: string[] = []
    let smallest = Number.POSITIVE_INFINITY
    for (const id of MISSIONS) {
      const model = modelFor(levelOf(id))
      if (!model) continue
      const worst = worstShareError(model, [1, 0.5, 0.25])
      report.push(`${id.padEnd(20)} ${worst.toFixed(2)}`)
      smallest = Math.min(smallest, worst)
    }
    // Written to the report so a reader of a failure sees all thirteen rather
    // than the first one that tripped.
    expect(smallest, `worst-case levels per mission:\n${report.join('\n')}`).toBeGreaterThan(4)
  })

  it('and on the two missions the measurement plan names, it is over 20', () => {
    // `adv_02_jumpSeat` is the cheapest mission in the game and the one
    // DEV-232's millisecond is on; `int_02_hoverJet` is the worst. They are the
    // two arms DEV-237's row schedules, so they are the two this decision has
    // to be defensible on.
    for (const id of ['adv_02_jumpSeat', 'int_02_hoverJet']) {
      const model = modelFor(levelOf(id))
      if (!model) throw new Error(`${id} has no sun`)
      expect(worstShareError(model, [1]), id).toBeGreaterThan(20)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §2. The split the bake actually makes
// ─────────────────────────────────────────────────────────────────────────

const MODEL: BakedLightModel = {
  sunToward: [0.3, 0.9, 0.31622776601683794],
  sunColor: [1.4, 0.8, 0.3],
  probe: Array.from({ length: 9 }, (_, i) => [0.4 - i * 0.03, 0.4 - i * 0.02, 0.5 - i * 0.02]),
}

describe('DEV-240 §2 — the two halves are the one factor, taken apart', () => {
  it('sums to bakedFactor, so the split rung and rung 3 bake the same light', () => {
    // The property that makes "exactly lossless again" true rather than
    // asserted: rung 3 writes `ambient + direct` in one attribute and the split
    // rung writes them in two, and nothing else may differ between them.
    const combined: [number, number, number] = [0, 0, 0]
    const ambient: [number, number, number] = [0, 0, 0]
    const direct: [number, number, number] = [0, 0, 0]
    for (const n of [
      [0, 1, 0],
      [0.3, 0.9, 0.31622776601683794],
      [-0.6, 0.2, -0.7745966692414834],
      [1, 0, 0],
      [0, -1, 0],
    ] as const) {
      bakedFactor(n[0], n[1], n[2], MODEL, combined)
      bakedFactorSplit(n[0], n[1], n[2], MODEL, ambient, direct)
      for (let k = 0; k < 3; k++) {
        expect((ambient[k] as number) + (direct[k] as number)).toBeCloseTo(
          combined[k] as number,
          12,
        )
      }
    }
  })

  it('puts the SUN in the direct half and nothing else, and the probe in the other', () => {
    // The separation, checked by moving one input at a time. A split that had
    // the two halves the wrong way round would still sum correctly.
    const ambient: [number, number, number] = [0, 0, 0]
    const direct: [number, number, number] = [0, 0, 0]
    const away: BakedLightModel = { ...MODEL, sunToward: [0, -1, 0] }
    bakedFactorSplit(0, 1, 0, away, ambient, direct)
    expect(direct).toEqual([0, 0, 0])
    expect(ambient[0]).toBeGreaterThan(0)
    const dark: BakedLightModel = { ...MODEL, probe: Array.from({ length: 9 }, () => [0, 0, 0]) }
    bakedFactorSplit(0, 1, 0, dark, ambient, direct)
    expect(ambient).toEqual([0, 0, 0])
    expect(direct[0]).toBeGreaterThan(0)
  })

  it('scales both halves by the raw albedo, vertex by vertex', () => {
    const raw = Float32Array.from([0.5, 0.4, 0.3, 0.25, 0.2, 0.15])
    const normals = Float32Array.from([0, 1, 0, 0, 1, 0])
    const ambient = new Float32Array(6)
    const direct = new Float32Array(6)
    bakeVertexColoursSplit(raw, normals, MODEL, ambient, direct)
    // The second vertex is half the first's albedo under the same normal, so
    // every channel of both halves is exactly halved.
    for (let k = 0; k < 3; k++) {
      expect(ambient[k + 3] as number).toBeCloseTo((ambient[k] as number) / 2, 12)
      expect(direct[k + 3] as number).toBeCloseTo((direct[k] as number) / 2, 12)
    }
    // And the two halves add up to what rung 3 would have written.
    const combined = new Float32Array(6)
    bakeVertexColours(raw, normals, MODEL, combined)
    for (let i = 0; i < 6; i++) {
      expect((ambient[i] as number) + (direct[i] as number)).toBeCloseTo(combined[i] as number, 6)
    }
  })

  it('refuses buffers that disagree about the vertex count', () => {
    expect(() =>
      bakeVertexColoursSplit(
        Float32Array.from([1, 1, 1]),
        Float32Array.from([0, 1, 0]),
        MODEL,
        new Float32Array(3),
        new Float32Array(6),
      ),
    ).toThrow(/lengths disagree/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §3. The shader
// ─────────────────────────────────────────────────────────────────────────

const SPLIT_WRITE =
  `vec3 outgoingLight = diffuseColor.rgb + diffuse * ${DIRECT_VARYING} * ` +
  'ff2ShadowOnly() + totalEmissiveRadiance;'

const splitFragment = (): string =>
  bakedLightPatchFragment(THREE.ShaderLib.physical.fragmentShader, 'split')

describe("DEV-240 §3 — the shader writes three's own semantics, term for term", () => {
  it('adds the shadowed direct half rather than multiplying the whole colour', () => {
    // The difference from rung 1, stated as the difference it is: rung 1 writes
    // `(ambient + direct) * s` and this writes `ambient + direct * s`. The two
    // agree only where the ambient is zero, and the reason shadowed ground in
    // this game is pale is that it is not.
    const src = splitFragment()
    expect(src).toContain(SPLIT_WRITE)
    expect(src).not.toContain('vec3 outgoingLight = diffuseColor.rgb * ff2ShadowOnly()')
  })

  it("multiplies the direct half by three's own tint uniform, as color_fragment does", () => {
    // `diffuseColor = vec4( diffuse, opacity )` then `diffuseColor *= vColor`,
    // so the AMBIENT half arrives already tinted. A direct half that skipped
    // the tint would light the two halves with two different materials — and on
    // the land the tint is (0.725, 0.539, 0.478), not white, so it would show.
    for (const lib of ['physical', 'standard', 'lambert'] as const) {
      expect(
        THREE.ShaderLib[lib].fragmentShader,
        `three's ${lib} no longer declares the tint as 'diffuse'`,
      ).toContain('uniform vec3 diffuse;')
    }
    expect(THREE.ShaderChunk.color_fragment).toContain('diffuseColor *= vColor;')
    expect(splitFragment()).toContain(`diffuse * ${DIRECT_VARYING}`)
  })

  it('keeps the per-fragment shadow — a getShadow call, not a baked term', () => {
    const src = splitFragment()
    expect(src).toContain('float ff2ShadowOnly()')
    expect(src).toContain('getShadow( directionalShadowMap[ 0 ]')
    expect(src).toContain('receiveShadow ?')
    // Composed with far-shadow by MIN, because that is what far-shadow writes:
    // two shadows of one sun compose by whichever is darker.
    expect(src).toContain('s = min( s, ff2SunHeightTerm() );')
  })

  it('declares the varying, and above main where the helper is', () => {
    const src = splitFragment()
    expect(src).toContain(`varying vec3 ${DIRECT_VARYING};`)
    expect(src.indexOf(`varying vec3 ${DIRECT_VARYING};`)).toBeLessThan(
      src.indexOf('void main() {'),
    )
    expect(src.indexOf('float ff2ShadowOnly()')).toBeLessThan(src.indexOf('void main() {'))
  })

  it('is still upstream of opaque_fragment, so the fog and the haze still run', () => {
    // `render/unity-fog.ts` injects immediately ABOVE `#include
    // <opaque_fragment>` and writes `outgoingLight` twice. A gate below it
    // deletes the fog, which is what `FF2_UNLIT` does and why this one is not
    // that gate.
    const src = splitFragment()
    expect(src.indexOf(SPLIT_WRITE)).toBeLessThan(src.indexOf('#include <opaque_fragment>'))
  })

  it('carries the attribute into the varying, once, at color_vertex', () => {
    const vertex = bakedLightPatchVertex(THREE.ShaderLib.physical.vertexShader, 'split')
    expect(vertex).toContain(`attribute vec3 ${DIRECT_ATTRIBUTE};`)
    expect(vertex).toContain(`varying vec3 ${DIRECT_VARYING};`)
    expect(vertex).toContain(`${DIRECT_VARYING} = ${DIRECT_ATTRIBUTE};`)
    expect(vertex.split(`${DIRECT_VARYING} = ${DIRECT_ATTRIBUTE};`).length - 1).toBe(1)
  })

  it('and three really does provide that hook, and the keyword it is written in', () => {
    // Read, not remembered. `#define attribute in` is what makes `attribute`
    // legal in the GLSL 3 three actually compiles, and `color_vertex` is the
    // one place the colour attribute is copied into its varying.
    for (const lib of ['physical', 'standard', 'lambert'] as const) {
      expect(THREE.ShaderLib[lib].vertexShader.split('#include <color_vertex>').length - 1).toBe(1)
    }
    const build = fs.readFileSync(
      path.join(process.cwd(), 'node_modules', 'three', 'build', 'three.module.js'),
      'utf8',
    )
    expect(build, "three no longer rewrites 'attribute' for GLSL 3").toContain(
      "'#define attribute in'",
    )
  })

  it('the VERTEX patch is the identity at every rung but split', () => {
    // Rung 3's program is the one DEV-232 measured, and a vertex shader that
    // gained a varying would be a different program with the same fragment
    // text. The golden in `baked-light.test.ts` covers the fragment; this
    // covers the other half of the pair.
    for (const rung of [1, 3] as const) {
      expect(bakedLightPatchVertex(THREE.ShaderLib.physical.vertexShader, rung)).toBe(
        THREE.ShaderLib.physical.vertexShader,
      )
    }
    expect(bakedLightPatchVertex(THREE.ShaderLib.physical.vertexShader)).toBe(
      THREE.ShaderLib.physical.vertexShader,
    )
  })

  it('throws rather than emitting a vertex patch it cannot place', () => {
    expect(() => bakedLightPatchVertex('void main() {}', 'split')).toThrow(/color_vertex/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §4. Three rungs, three programs
// ─────────────────────────────────────────────────────────────────────────

const compileVertex = (m: THREE.Material): string => {
  const shader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
  }
  m.onBeforeCompile(shader as never, null as never)
  return shader.vertexShader
}

describe('DEV-240 §4 — three rungs are three programs', () => {
  const keyed = (rung: BakedLightRung): string => {
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    setBakedLight(m, true, rung)
    return m.customProgramCacheKey()
  }

  it('gives all three rungs distinct cache keys', () => {
    // If two hashed alike, whichever compiled first would win for both and an
    // A/B would photograph one rung twice — `render/program-cache-key.ts`'s
    // original bug, in a new place.
    const keys = BAKED_LIGHT_RUNGS.map(keyed)
    expect(new Set(keys).size).toBe(BAKED_LIGHT_RUNGS.length)
  })

  it('leaves rung 3 contributing NOTHING to the tail, as DEV-232 measured it', () => {
    // Captured AFTER installing, because three's own
    // `Material.customProgramCacheKey` returns `this.onBeforeCompile.toString()`
    // — installing the patch changes the base on its own, which is the whole
    // reason `program-cache-key.ts` exists. What has to hold is that the RUNG
    // adds nothing on top of it at 3.
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    setBakedLight(m, true, 3)
    const at3 = m.customProgramCacheKey()
    expect(at3.endsWith('|baked-light')).toBe(true)
    setBakedLight(m, true, 'split')
    expect(m.customProgramCacheKey()).toBe(`${at3}|rungsplit`)
    setBakedLight(m, true, 1)
    expect(m.customProgramCacheKey()).toBe(`${at3}|rung1`)
    setBakedLight(m, false, 3)
    expect(m.customProgramCacheKey()).toBe(at3)
  })

  it('compiles the vertex text the DEFINES ask for, not the one install time asked for', () => {
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    setBakedLight(m, true, 3)
    expect(compileVertex(m)).toBe(THREE.ShaderLib.physical.vertexShader)
    setBakedLight(m, true, 'split')
    expect(bakedRungOf(m)).toBe('split')
    expect(compileVertex(m)).toContain(`${DIRECT_VARYING} = ${DIRECT_ATTRIBUTE};`)
    setBakedLight(m, true, 3)
    expect(compileVertex(m)).toBe(THREE.ShaderLib.physical.vertexShader)
  })

  it('never leaves two rung names standing at once', () => {
    const m = new THREE.MeshStandardMaterial()
    for (const [on, rung] of [
      [true, 1],
      [true, 'split'],
      [true, 3],
      [true, 'split'],
      [true, 1],
      [false, 'split'],
      [true, 'split'],
    ] as const) {
      setBakedLight(m, on, rung)
      const names = Object.keys(m.defines ?? {})
      const rungNames = names.filter((n) => n === BAKED_RUNG1_DEFINE || n === BAKED_SPLIT_DEFINE)
      expect(rungNames.length).toBeLessThanOrEqual(1)
      if (rungNames.length === 1) expect(names).toContain(BAKED_LIGHT_DEFINE)
    }
  })

  it('writes the THREE defines in ONE insertion order by every route (DEV-194)', () => {
    // three walks `material.defines` with `for ( const name in … )`, so a key
    // that MOVES makes the program a function of the run's HISTORY rather than
    // of its state — the ocean paid 318 ms mid-flight for exactly that. The
    // third name changes nothing about the rule and everything about the number
    // of routes there are to get it wrong.
    const routes: BakedLightRung[][] = [
      ['split'],
      [3, 'split'],
      [1, 'split'],
      [3, 1, 'split'],
      ['split', 3, 'split'],
      [1, 3, 1, 'split'],
    ]
    const orders = new Set<string>()
    for (const route of routes) {
      const m = new THREE.MeshStandardMaterial()
      installBakedLight(m)
      for (const rung of route) setBakedLight(m, true, rung)
      orders.add(Object.keys(m.defines ?? {}).join(','))
    }
    expect(orders.size, `every route must land on one order, saw ${[...orders].join(' | ')}`).toBe(
      1,
    )
    expect([...orders][0]).toContain(`${BAKED_LIGHT_DEFINE},${BAKED_SPLIT_DEFINE}`)
  })

  it('moves only on a real change, so re-stating an arm does not re-fetch a program', () => {
    const m = new THREE.MeshStandardMaterial()
    expect(setBakedLight(m, true, 'split')).toBe(true)
    expect(setBakedLight(m, true, 'split')).toBe(false)
    expect(setBakedLight(m, true, 3)).toBe(true)
    expect(setBakedLight(m, true, 3)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §5. The second attribute: lifecycle, and what it costs
// ─────────────────────────────────────────────────────────────────────────

const world = () => {
  const scene = new THREE.Scene()
  const sun = new THREE.DirectionalLight(0xffffff, 1)
  sun.position.set(0, 100, 0)
  scene.add(sun)
  const probe = new THREE.LightProbe()
  ;(probe.sh.coefficients[0] as THREE.Vector3).set(0.4, 0.4, 0.5)
  scene.add(probe)
  const root = new THREE.Group()
  scene.add(root)
  const material = new THREE.MeshStandardMaterial()
  const baked = createBakedLight()
  baked.applyTo(material)
  baked.addRoot(root)
  const g = new THREE.BufferGeometry()
  g.setAttribute(
    'color',
    new THREE.BufferAttribute(Float32Array.from([0.5, 0.4, 0.3, 0.5, 0.4, 0.3]), 3),
  )
  g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 0, 1, 0]), 3))
  root.add(new THREE.Mesh(g, material))
  baked.offer(g)
  return { scene, material, baked, geometry: g }
}

describe('DEV-240 §5 — the attribute is written with the define and deleted with it', () => {
  it('creates ff2Direct at the split rung, with the colour attribute’s own count', () => {
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    const report = w.baked.refresh(w.scene)
    expect(report.on).toBe(true)
    expect(report.liveRung).toBe('split')
    const direct = w.geometry.getAttribute(DIRECT_ATTRIBUTE)
    expect(direct, 'the split rung left the geometry without its direct half').toBeTruthy()
    expect(direct.itemSize).toBe(3)
    expect(direct.count).toBe(w.geometry.getAttribute('color').count)
  })

  it('the colour attribute holds the AMBIENT half alone once split', () => {
    // The whole point, at the buffer: under rungs 1 and 3 `color` carries
    // ambient + direct, and under `split` it carries the ambient and the sun
    // has moved next door. With the sun overhead and an up normal the direct
    // half is large, so the two are not close.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung(3)
    w.baked.refresh(w.scene)
    const combined = Array.from(w.geometry.getAttribute('color').array.slice(0, 3))
    w.baked.setRung('split')
    w.baked.refresh(w.scene)
    const ambient = Array.from(w.geometry.getAttribute('color').array.slice(0, 3))
    const direct = Array.from(w.geometry.getAttribute(DIRECT_ATTRIBUTE).array.slice(0, 3))
    for (let k = 0; k < 3; k++) {
      expect((ambient[k] as number) + (direct[k] as number)).toBeCloseTo(combined[k] as number, 6)
      expect(direct[k] as number).toBeGreaterThan(0)
      expect(ambient[k] as number).toBeLessThan(combined[k] as number)
    }
  })

  it('deletes ff2Direct the moment the rung moves off split, and when the bake goes off', () => {
    // A program compiled for rung 1 or 3 does not read the attribute, so a
    // buffer left behind would be 12 bytes a vertex of VRAM nobody is paying
    // for on purpose.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    w.baked.refresh(w.scene)
    expect(w.geometry.getAttribute(DIRECT_ATTRIBUTE)).toBeTruthy()
    w.baked.setRung(1)
    w.baked.refresh(w.scene)
    expect(w.geometry.getAttribute(DIRECT_ATTRIBUTE)).toBeUndefined()
    w.baked.setRung('split')
    w.baked.refresh(w.scene)
    expect(w.geometry.getAttribute(DIRECT_ATTRIBUTE)).toBeTruthy()
    w.baked.setEnabled(false)
    w.baked.refresh(w.scene)
    expect(w.geometry.getAttribute(DIRECT_ATTRIBUTE)).toBeUndefined()
  })

  it('a chunk offered mid-flight arrives with both halves', () => {
    // `offer()` is the door a streaming chunk comes through, and it bakes
    // immediately rather than waiting for the next refresh — so a chunk that
    // arrived between refreshes would otherwise draw an unlit albedo, or, with
    // the split define live, an albedo with no attribute behind its sun.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    w.baked.refresh(w.scene)
    const g = new THREE.BufferGeometry()
    g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from([0.6, 0.5, 0.4]), 3))
    g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from([0, 1, 0]), 3))
    w.baked.offer(g)
    expect(g.getAttribute(DIRECT_ATTRIBUTE)).toBeTruthy()
  })

  it('NAMES the split define in the report, because that line is the mechanism check', () => {
    // Found by the harness rather than by this file: the first version of
    // DEV-240 added `FF2_BAKED_SPLIT` to `setBakedLight` and not to the
    // report's `defines`, so `tests/e2e/baked-rung-photos.spec.ts` printed
    //
    //   island-lit/split  live=split  defines=[FF2_BAKED_LIGHT]
    //
    // for an arm that was demonstrably running the split shader. That is the
    // mechanism check lying in the QUIET direction — a reader of an
    // `xr-vrto3d-trace` log would have seen rung 3's define list beside the
    // split rung's name and had no way to tell which was wrong.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    expect(w.baked.refresh(w.scene).defines).toEqual([BAKED_LIGHT_DEFINE, BAKED_SPLIT_DEFINE])
    w.baked.setRung(1)
    expect(w.baked.refresh(w.scene).defines).toEqual([BAKED_LIGHT_DEFINE, BAKED_RUNG1_DEFINE])
    w.baked.setRung(3)
    expect(w.baked.refresh(w.scene).defines).toEqual([BAKED_LIGHT_DEFINE])
  })

  it('every define this module writes is on the ONE list the report reads', () => {
    // The structural half of the bug above: a name that has to be added in two
    // places is a name that will be added in one. Checked by asking the
    // materials what they are carrying rather than by reading the list back to
    // itself — for each rung, whatever `setBakedLight` wrote must be a subset
    // of what `BAKED_DEFINES` names.
    for (const rung of BAKED_LIGHT_RUNGS) {
      const m = new THREE.MeshStandardMaterial()
      // three's own `{ STANDARD: '' }` is on the material before anything here
      // touches it, so the subject is what setBakedLight ADDS.
      const before = new Set(Object.keys(m.defines ?? {}))
      setBakedLight(m, true, rung)
      for (const name of Object.keys(m.defines ?? {})) {
        if (before.has(name)) continue
        expect(BAKED_DEFINES, `rung ${String(rung)} writes ${name}`).toContain(name)
      }
    }
  })

  it('counts the vertices that are LIVE, not the ones it has ever baked', () => {
    // A chunk whose LOD changes has its geometry REPLACED and disposed, and the
    // replaced one is never un-baked because it is no longer in the scene to be
    // walked. Accumulated, the count only ever rises and `directBytes` quotes
    // VRAM for buffers that were freed with their geometries. `refresh`
    // re-counts from the traversal, so what leaves the scene leaves the books.
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    expect(w.baked.refresh(w.scene).vertices).toBe(2)
    const replacement = new THREE.BufferGeometry()
    replacement.setAttribute(
      'color',
      new THREE.BufferAttribute(Float32Array.from([0.6, 0.5, 0.4]), 3),
    )
    replacement.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from([0, 1, 0]), 3))
    // The chunk mesh swaps its geometry, exactly as `load-terrain.ts` does.
    w.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && m.geometry === w.geometry) m.geometry = replacement
    })
    w.baked.offer(replacement)
    const after = w.baked.refresh(w.scene)
    expect(after.baked, 'the replaced geometry is still on the books').toBe(1)
    expect(after.vertices).toBe(1)
    expect(after.directBytes).toBe(1 * 3 * 4)
  })

  it('reports the vertices it is holding and what they cost, measured not estimated', () => {
    const w = world()
    w.baked.setEnabled(true)
    w.baked.setRung('split')
    const report = w.baked.refresh(w.scene)
    expect(report.vertices).toBe(2)
    expect(report.directBytes).toBe(2 * 3 * 4)
    w.baked.setRung(3)
    // The vertices are still baked; the second attribute is not there to pay
    // for, so the price is zero rather than "the same number at another rung".
    expect(w.baked.refresh(w.scene).directBytes).toBe(0)
    w.baked.setEnabled(false)
    const off = w.baked.refresh(w.scene)
    expect(off.vertices).toBe(0)
    expect(off.directBytes).toBe(0)
  })

  it('names a zero default for the attribute, and three still consults it', () => {
    // A program that declares `attribute vec3 ff2Direct` and meets a geometry
    // without one does not fail: WebGL reads the GENERIC vertex attribute,
    // whose value is whatever the last `vertexAttrib*fv` on that location left
    // there. three's binder consults `material.defaultAttributeValues` for
    // exactly this, which is its private behaviour and is therefore read out of
    // its build rather than trusted.
    const m = new THREE.MeshStandardMaterial()
    installBakedLight(m)
    expect(
      (m as unknown as { defaultAttributeValues?: Record<string, number[]> })
        .defaultAttributeValues?.[DIRECT_ATTRIBUTE],
    ).toEqual([0, 0, 0])
    const build = fs.readFileSync(
      path.join(process.cwd(), 'node_modules', 'three', 'build', 'three.module.js'),
      'utf8',
    )
    expect(build).toContain(
      'const materialDefaultAttributeValues = material.defaultAttributeValues;',
    )
    expect(build).toContain('gl.vertexAttrib3fv( programAttribute.location, value );')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §6. The rung is data, and it is reachable
// ─────────────────────────────────────────────────────────────────────────

const EDITION = (): Edition =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'content', 'editions', 'anniversary.json'), 'utf8'),
  ) as Edition

describe('DEV-240 §6 — the preset and the pin both reach it', () => {
  it("names the rung 'split' rather than taking the next free integer", () => {
    // The plan's ladder is numbered and its rung 2 means something else
    // (rung 1 plus a baked `ff2SunHeightTerm`). A fourth integer would read as
    // a position on that ladder it does not hold.
    expect(BAKED_LIGHT_RUNGS).toContain('split')
    expect(BAKED_LIGHT_RUNGS).not.toContain(2)
    expect(BAKED_LIGHT_RUNGS).not.toContain(4)
  })

  it('validates a preset carrying it, and still refuses the rung that is NOT built', () => {
    const base = EDITION()
    const withRung = (rung: unknown): Edition =>
      ({
        ...base,
        terrain: { ...base.terrain, bakedLight: { ...base.terrain.bakedLight, rung } },
      }) as Edition
    expect(() => validateEdition(withRung('split'))).not.toThrow()
    expect(() => validateEdition(withRung(2))).toThrow(/rung/)
    expect(() => validateEdition(withRung('SPLIT'))).toThrow(/rung/)
    expect(() => validateEdition(withRung(4))).toThrow(/rung/)
  })

  it('ships OFF at rung 3 in both editions — nothing in the shipped build moves', () => {
    for (const id of ['anniversary', 'classic']) {
      const edition = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'content', 'editions', `${id}.json`), 'utf8'),
      ) as Edition
      expect(edition.terrain.bakedLight.enabled, id).toBe(false)
      expect(edition.terrain.bakedLight.rung, id).toBe(3)
    }
  })

  it('?bakedRung=split pins it over the preset, the way ?bakedRung=1 does', () => {
    // `VRTO3D_FLAGS_ON` cannot reach the rung — its flip is
    // `block[b] = { ...target, enabled }`, which spreads every other field of
    // the block straight through from the preset. So the flag says *bake* and
    // the pin says *which rung*.
    const seen: BakedLightRung[] = []
    attachEditionBakedLight(
      {
        setEnabled: () => {},
        setRung: (rung) => {
          seen.push(rung)
        },
      },
      {
        current: { terrain: { bakedLight: { enabled: true, rung: 3 } } },
        subscribe: () => () => {},
      },
      () => {},
      'split',
    )
    expect(seen).toEqual(['split'])
  })
})
