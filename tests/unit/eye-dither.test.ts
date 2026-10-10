// tests/unit/eye-dither.test.ts: the PCF penumbra and the LOD screen-door
// seed from the EYE's pixel. DEV-556.
//
// What a node test can establish, with three's own build as the oracle:
//   * three's stock chunks DO seed from the window (the premise of the bug,
//     read rather than remembered), and after the install no chunk does;
//   * every ShaderLib program that includes a rewritten chunk carries the
//     uniform, and three's own `UniformsUtils.clone` keeps it LIVE (shared by
//     reference) rather than freezing a copy;
//   * the value reads the viewport three is drawing into, at read time;
//   * composed the way a program is really built (the physical shader, the
//     fog and the fade patches in call-site order, includes resolved, then
//     preprocessed), each configuration declares the uniform EXACTLY once and
//     before its first use. A uniform declared twice does not compile, and
//     none of the gates in `pnpm check` compiles a shader.
//
// What it cannot: whether the two eyes now match. That is
// `tests/e2e/stereo-parity.spec.ts`, red on main and green with this.

import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetEyeDitherForTests,
  EYE_DITHER_CHUNKS,
  EYE_ORIGIN_UNIFORM,
  EYE_PIXEL_PARS,
  EYE_SEED,
  eyeDitherChunk,
  eyeOrigin,
  useEyeConsistentDither,
  WINDOW_SEED,
} from '@/render/eye-dither'
import { createLodFadePool, LOD_FADE_DEFINE } from '@/render/lod-fade'

afterEach(() => _resetEyeDitherForTests())

const names = Object.keys(EYE_DITHER_CHUNKS) as (keyof typeof EYE_DITHER_CHUNKS)[]

/** A viewport three would report, as `getCurrentViewport` copies it out. */
const viewportAt = (x: number, y: number) => ({
  getCurrentViewport: (target: THREE.Vector4) => target.set(x, y, 800, 720),
})

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** three's `resolveIncludes`, against whatever `THREE.ShaderChunk` holds now. */
const resolve = (src: string): string =>
  src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name]
    if (chunk === undefined) throw new Error(`no chunk ${name}`)
    return resolve(chunk)
  })

/**
 * The lines a GLSL preprocessor would keep, for a given set of macros. Enough
 * of one for three's chunks: `#if` / `#ifdef` / `#ifndef` / `#elif` / `#else`
 * / `#endif`, `defined( X )`, integer comparisons, and `#define` updating the
 * set as it goes (which is the whole point of a guard).
 */
const preprocess = (src: string, defines: Record<string, number>): string[] => {
  const macros = new Map(Object.entries(defines))
  const evalIf = (expr: string): boolean => {
    const js = expr
      .replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n: string) => (macros.has(n) ? '1' : '0'))
      .replace(/defined\s+(\w+)/g, (_, n: string) => (macros.has(n) ? '1' : '0'))
      .replace(/\b[A-Za-z_]\w*\b/g, (n) => String(macros.get(n) ?? 0))
    return Boolean(Function(`return (${js})`)())
  }
  const kept: string[] = []
  // Each frame: is this branch live, has any branch of this #if been taken,
  // and was the enclosing block live.
  const stack: { live: boolean; taken: boolean; outer: boolean }[] = []
  const live = () => stack.every((f) => f.live)
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    const d = /^#\s*(\w+)\s*(.*)$/.exec(line)
    const kw = d?.[1]
    const rest = d?.[2] ?? ''
    if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') {
      const outer = live()
      const v =
        kw === 'if' ? evalIf(rest) : kw === 'ifdef' ? macros.has(rest) : !macros.has(rest.trim())
      stack.push({ live: v, taken: v, outer })
    } else if (kw === 'elif') {
      const f = stack[stack.length - 1] as (typeof stack)[number]
      f.live = !f.taken && evalIf(rest)
      f.taken ||= f.live
    } else if (kw === 'else') {
      const f = stack[stack.length - 1] as (typeof stack)[number]
      f.live = !f.taken
      f.taken = true
    } else if (kw === 'endif') {
      stack.pop()
    } else if (live()) {
      if (kw === 'define') {
        const m = /^(\w+)(?:\s+(-?\d+))?/.exec(rest)
        if (m?.[1]) macros.set(m[1], m[2] ? Number(m[2]) : 1)
      }
      kept.push(raw)
    }
  }
  return kept
}

describe("three's stock chunks (the premise)", () => {
  it('seed the PCF rotation and the dither from the WINDOW coordinate', () => {
    // Read out of three's build, so a three upgrade that changes this is a red
    // test and not a stale comment.
    expect(count(THREE.ShaderChunk.shadowmap_pars_fragment, WINDOW_SEED)).toBe(2)
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toContain(
      'interleavedGradientNoise( gl_FragCoord.xy )',
    )
    expect(count(THREE.ShaderChunk.dithering_pars_fragment, WINDOW_SEED)).toBe(1)
  })
})

describe('the rewritten chunks', () => {
  it.each(names)('%s seeds every use from the eye, and keeps the rest of the chunk', (name) => {
    const stock = THREE.ShaderChunk[name]
    const out = eyeDitherChunk(name, stock)
    // The pars' own definition of the helper is the only window read left.
    expect(count(out.replace(EYE_PIXEL_PARS, ''), WINDOW_SEED)).toBe(0)
    expect(count(out.replace(EYE_PIXEL_PARS, ''), EYE_SEED)).toBe(count(stock, WINDOW_SEED))
    // The pars sit in front of the noise's own declaration, so they are inside
    // exactly the `#if` that gates it, and before every call.
    expect(out.indexOf(EYE_PIXEL_PARS)).toBeLessThan(out.indexOf(EYE_DITHER_CHUNKS[name]))
    expect(out.indexOf(EYE_PIXEL_PARS)).toBeLessThan(out.indexOf(EYE_SEED))
    // Nothing else moved.
    expect(out.replace(EYE_PIXEL_PARS, '').replaceAll(EYE_SEED, WINDOW_SEED)).toBe(stock)
  })

  it('throws, rather than booting without the fix, when three moves the anchor', () => {
    expect(() => eyeDitherChunk('shadowmap_pars_fragment', 'float x;')).toThrow(/eye-dither/)
  })

  it('leaves NO chunk in three seeding from the window, once installed', () => {
    useEyeConsistentDither(viewportAt(0, 0))
    const seeded = Object.entries(THREE.ShaderChunk)
      .filter(([, text]) => typeof text === 'string')
      .filter(([, text]) => count((text as string).replaceAll(EYE_PIXEL_PARS, ''), WINDOW_SEED))
      .map(([name]) => name)
    expect(seeded).toEqual([])
  })
})

describe('the uniform', () => {
  it('is on every ShaderLib program that includes a rewritten chunk', () => {
    useEyeConsistentDither(viewportAt(0, 0))
    const users = Object.entries(THREE.ShaderLib).filter(([, s]) =>
      names.some((n) => s.fragmentShader.includes(`#include <${n}>`)),
    )
    // The lit materials are the ones that matter: standard and physical share
    // the `physical` entry.
    expect(users.map(([k]) => k)).toEqual(
      expect.arrayContaining(['physical', 'standard', 'lambert']),
    )
    for (const [k, s] of users) expect(s.uniforms[EYE_ORIGIN_UNIFORM], k).toBeDefined()
  })

  it("survives three's UniformsUtils.clone LIVE, by reference", () => {
    // `WebGLPrograms.getUniforms` clones the ShaderLib entry's uniforms for
    // each material it compiles. A Vector2 would be copied and frozen there.
    useEyeConsistentDither(viewportAt(0, 0))
    const cloned = THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms)
    expect(cloned[EYE_ORIGIN_UNIFORM]?.value).toBe(eyeOrigin)
  })

  it('reads the viewport three is drawing into, at the moment it is read', () => {
    const right = viewportAt(800, 0)
    useEyeConsistentDither(right)
    expect([eyeOrigin.x, eyeOrigin.y]).toEqual([800, 0])
    useEyeConsistentDither(viewportAt(0, 0))
    expect([eyeOrigin.x, eyeOrigin.y]).toEqual([0, 0])
  })

  it('is zero with no renderer bound, which is a flat frame', () => {
    expect([eyeOrigin.x, eyeOrigin.y]).toEqual([0, 0])
  })

  it('is installed once, and the reset restores three exactly', () => {
    const stock = names.map((n) => THREE.ShaderChunk[n])
    useEyeConsistentDither(viewportAt(0, 0))
    const once = names.map((n) => THREE.ShaderChunk[n])
    useEyeConsistentDither(viewportAt(0, 0))
    expect(names.map((n) => THREE.ShaderChunk[n])).toEqual(once)
    _resetEyeDitherForTests()
    expect(names.map((n) => THREE.ShaderChunk[n])).toEqual(stock)
    expect(THREE.ShaderLib.physical.uniforms[EYE_ORIGIN_UNIFORM]).toBeUndefined()
  })
})

describe('composed as a program is really built', () => {
  /**
   * The physical fragment shader through the fade's `onBeforeCompile` (the
   * clone's, which delegates to the base's chain), includes resolved against
   * the INSTALLED chunks, then preprocessed with `defines`.
   */
  const asShipped = (clone: boolean, defines: Record<string, number>) => {
    useEyeConsistentDither(viewportAt(0, 0))
    const pool = createLodFadePool()
    const base = new THREE.MeshPhysicalMaterial({ vertexColors: true })
    pool.applyTo(base)
    const pair = pool.acquire(base)
    if (!pair) throw new Error('no pair')
    const m = clone ? pair.incoming : base
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    m.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    const all = { STANDARD: 1, PHYSICAL: 1, ...defines, ...(clone ? { [LOD_FADE_DEFINE]: 1 } : {}) }
    const kept = preprocess(resolve(shader.fragmentShader), all).join('\n')
    return { kept, uniforms: shader.uniforms }
  }

  const SHADOWS = {
    USE_SHADOWMAP: 1,
    SHADOWMAP_TYPE_PCF: 1,
    NUM_DIR_LIGHT_SHADOWS: 1,
    NUM_DIR_LIGHTS: 1,
  }

  it.each([
    ['a fading chunk that receives a shadow', true, SHADOWS],
    ['a fading chunk with no shadow map (Anniversary at low)', true, {}],
    ['a settled chunk that receives a shadow', false, SHADOWS],
  ])('%s: one declaration, before every use', (_, clone, defines) => {
    const { kept, uniforms } = asShipped(clone, defines)
    expect(count(kept, `uniform vec2 ${EYE_ORIGIN_UNIFORM};`)).toBe(1)
    expect(count(kept, 'vec2 ff2EyePixel() {')).toBe(1)
    const declared = kept.indexOf('vec2 ff2EyePixel() {')
    const uses = [...kept.matchAll(/ff2EyePixel\(\)(?! \{)/g)].map((m) => m.index ?? 0)
    // Positive first: the seed is really USED in this configuration, so a
    // missing use cannot read as a pass.
    expect(uses.length).toBeGreaterThan(0)
    for (const at of uses) expect(at).toBeGreaterThan(declared)
    expect(uniforms[EYE_ORIGIN_UNIFORM]?.value).toBe(eyeOrigin)
    // And no live window seed anywhere in the program.
    expect(count(kept.replace(/vec2 ff2EyePixel\(\) \{[^}]*\}/, ''), WINDOW_SEED)).toBe(0)
  })

  it('the guard is load-bearing: the physical shader carries three copies in its text', () => {
    // Without this the "one declaration" above could be one because only one
    // copy was ever spliced, and the guard would be untested.
    useEyeConsistentDither(viewportAt(0, 0))
    const pool = createLodFadePool()
    const base = new THREE.MeshPhysicalMaterial()
    pool.applyTo(base)
    const shader = {
      uniforms: {},
      vertexShader: '',
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    }
    base.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer)
    expect(count(resolve(shader.fragmentShader), `uniform vec2 ${EYE_ORIGIN_UNIFORM};`)).toBe(3)
    // Three: the shadow chunk, the dither chunk, and the fade. One survives.
  })

  it('the fade discards on the eye seed, in both directions', () => {
    const { kept } = asShipped(true, SHADOWS)
    expect(kept).toContain(`ff2LodFadeDither( ${EYE_SEED} ) >= uLodFade.x ) discard`)
    expect(kept).toContain(`ff2LodFadeDither( ${EYE_SEED} ) < uLodFade.x ) discard`)
  })

  it('the PCF rotation is the eye seed, in the program that draws a shadow', () => {
    const { kept } = asShipped(false, SHADOWS)
    expect(kept).toContain(`interleavedGradientNoise( ${EYE_SEED} ) * PI2`)
  })
})
