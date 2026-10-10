// tests/unit/program-cache-key.test.ts — the land was doing the ocean's dance.
//
// Matt, having just fired it up: *"it looks like the terrain is doing the
// animation the ocean should be."*
//
// It was, and the flat sea from two sessions earlier was the SAME bug with the
// coin landing the other way. three's `getProgramCacheKey` is built from the
// shader id, the defines, the parameters, the output colour space and
// `customProgramCacheKey()` — and **not** from `onBeforeCompile`. Two
// `MeshStandardMaterial`s that differ only in their injected GLSL therefore
// share one compiled program, and whichever compiled first wins for both.
//
// Which one wins is `painterSortStable`, which orders by `material.id` —
// creation order — and the two Simonet terrains load under one `Promise.all`.
// So it is a coin flip per run, it never errors, and a screenshot taken on one
// run disagrees with the same screenshot on the next.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  chainBeforeCompile,
  chainShaderPatch,
  setDefineInPlace,
  tagProgramCacheKey,
} from '@/render/program-cache-key'
import { createUnityFog } from '@/render/unity-fog'
import { applyWaterWaves, type WaterDisplace } from '@/render/water'

/** Exactly what `terrainMaterial` builds, minus the numbers that are uniforms. */
const terrainLike = () =>
  new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0,
    side: THREE.FrontSide,
  })

const DISPLACE: WaterDisplace = {
  amplitude: 4,
  direction: 322,
  frequency: 0.4,
  noise: -1,
  speed: 2,
  live: true,
} as unknown as WaterDisplace

const fog = () =>
  createUnityFog({
    mode: 2,
    density: 0.00025,
    linearStart: 100,
    linearEnd: 2500,
    color: [0.87, 0.66, 0.7],
    distanceFog: true,
    heightFog: true,
    useRadialDistance: true,
    height: 387,
    heightDensity: 0.03,
    startDistance: 256,
  })

describe('the bug itself', () => {
  it('three hashes the callback by its SOURCE TEXT, which is the hole', () => {
    // three's default `customProgramCacheKey()` returns
    // `this.onBeforeCompile.toString()`. That catches two DIFFERENT functions —
    // and misses two instances of the SAME function with different closures,
    // which is exactly what a chained patcher produces.
    const patch = (m: THREE.Material, extra: string) => {
      const previous = m.onBeforeCompile
      m.onBeforeCompile = (shader, renderer) => {
        previous?.call(m, shader, renderer)
        shader.vertexShader = extra + shader.vertexShader
      }
    }
    const a = terrainLike()
    const b = terrainLike()
    patch(a, '// one')
    patch(b, '// two')
    // Different injected GLSL, same source text, same key. No error, no warning.
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
  })

  it('and that is precisely how the land and the sea collided', () => {
    // The ORDER is the whole thing: `loadTerrain` patches the waves, then
    // `app.ts` patches the fog onto BOTH terrains afterwards. So the last
    // assignment on each is the same arrow function out of `unity-fog.ts`, and
    // the water's contribution is hidden inside `previous` where `toString()`
    // cannot see it.
    const land = terrainLike()
    const sea = terrainLike()
    applyWaterWaves(sea, DISPLACE)
    fog().applyTo(land)
    fog().applyTo(sea)
    // Strip the tags to see the world as it was until now.
    const bare = THREE.Material.prototype.customProgramCacheKey
    land.customProgramCacheKey = bare
    sea.customProgramCacheKey = bare
    expect(sea.customProgramCacheKey()).toBe(land.customProgramCacheKey())
  })

  it('the LAND and the SEA hashed identically before the fix', () => {
    // Colour and roughness are uniforms, not defines, so the two terrains'
    // different tints never entered the key. Nothing about them differed.
    const land = terrainLike()
    const sea = terrainLike()
    land.color.setRGB(0.725, 0.539, 0.478)
    land.roughness = 0.45
    sea.color.setRGB(0.19, 0.31, 0.6)
    sea.roughness = 0.9
    expect(land.customProgramCacheKey()).toBe(sea.customProgramCacheKey())
  })
})

describe('the fix', () => {
  it('separates a wave-displaced material from a plain one', () => {
    const land = terrainLike()
    const sea = terrainLike()
    fog().applyTo(land)
    fog().applyTo(sea)
    applyWaterWaves(sea, DISPLACE)
    expect(sea.customProgramCacheKey()).not.toBe(land.customProgramCacheKey())
  })

  it('does NOT split materials whose injected source is the same', () => {
    // The other failure mode: a tag carrying something uniform-shaped would
    // compile a separate program per chunk. Two fogged terrains must agree.
    const a = terrainLike()
    const b = terrainLike()
    fog().applyTo(a)
    fog().applyTo(b)
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey())
  })

  it('splits the water variants, because they really are different GLSL', () => {
    // `specular` and `reflects` gate source text, not uniforms. Sharing a
    // program across them would silently drop a term.
    const plain = terrainLike()
    const lit = terrainLike()
    applyWaterWaves(plain, DISPLACE)
    applyWaterWaves(lit, DISPLACE, {
      specColor: [0.5, 0.5, 0.5],
      shininess: 0.201,
      sun: { direction: [1, 0, 0], colorLinear: [1, 1, 1], intensity: 1.3 },
      color: [0.23, 0.3, 0.42, 0.5],
      fresnel: 1,
      skySh: Array.from({ length: 9 }, () => [0.1, 0.1, 0.1]),
    } as unknown as Parameters<typeof applyWaterWaves>[2])
    expect(plain.customProgramCacheKey()).not.toBe(lit.customProgramCacheKey())
  })

  it('CHAINS, so the fog tag and the water tag both survive', () => {
    // Assignment rather than chaining is how the original bug happened once
    // already, in `onBeforeCompile`. Same shape, same trap.
    const m = terrainLike()
    tagProgramCacheKey(m, 'one')
    tagProgramCacheKey(m, 'two')
    expect(m.customProgramCacheKey()).toContain('one')
    expect(m.customProgramCacheKey()).toContain('two')
  })

  it('only ever ADDS to whatever three already returns', () => {
    // three's default is `onBeforeCompile.toString()`. The tag must extend it,
    // not replace it — dropping it would re-open the hole for anything that
    // patches without tagging.
    const m = terrainLike()
    const base = m.customProgramCacheKey()
    tagProgramCacheKey(m, 'tok')
    expect(m.customProgramCacheKey()).toBe(`${base}|tok`)
  })
})

describe('chainShaderPatch: the one place a patch is chained (RC-1)', () => {
  type Hook = (
    shader: THREE.WebGLProgramParametersWithUniforms,
    renderer: THREE.WebGLRenderer,
  ) => void
  const shaderOf = (): THREE.WebGLProgramParametersWithUniforms =>
    ({
      uniforms: {},
      vertexShader: 'V',
      fragmentShader: 'F',
    }) as unknown as THREE.WebGLProgramParametersWithUniforms
  const compile = (m: THREE.Material): THREE.WebGLProgramParametersWithUniforms => {
    const shader = shaderOf()
    ;(m.onBeforeCompile as Hook).call(m, shader, {} as THREE.WebGLRenderer)
    return shader
  }

  it('tags the key once, with exactly the token it was given, after what was there', () => {
    const m = terrainLike()
    chainShaderPatch(m, { tag: 'one' })
    // The default key is the hook's own text, which the chain changes; the TAG
    // is what is added, once, at the end.
    expect(m.customProgramCacheKey().endsWith('|one')).toBe(true)
    expect(m.customProgramCacheKey().match(/\|one/g)).toHaveLength(1)
  })

  it('runs the previous hook FIRST, then uniforms, vertex, fragment, after', () => {
    const m = terrainLike()
    const order: string[] = []
    m.onBeforeCompile = () => {
      order.push('previous')
    }
    const uniforms = { uA: { value: 1 } }
    chainShaderPatch(m, {
      tag: 'order',
      uniforms,
      vertex: (s) => {
        order.push('vertex')
        return `${s}+v`
      },
      fragment: (s) => {
        order.push('fragment')
        return `${s}+f`
      },
      after: (shader) => {
        order.push(`after:${shader.vertexShader}:${shader.fragmentShader}`)
      },
    })
    const shader = compile(m)
    expect(order).toEqual(['previous', 'vertex', 'fragment', 'after:V+v:F+f'])
    expect(shader.uniforms.uA).toBe(uniforms.uA)
  })

  it('chains: a second patch runs after the first, and both tags are in the key', () => {
    const m = terrainLike()
    chainShaderPatch(m, { tag: 'first', fragment: (s) => `${s}1` })
    chainShaderPatch(m, { tag: 'second', fragment: (s) => `${s}2` })
    expect(compile(m).fragmentShader).toBe('F12')
    expect(m.customProgramCacheKey()).toMatch(/\|first\|second$/)
  })

  it('marks the material dirty, so an already-compiled one is re-resolved', () => {
    const m = terrainLike()
    const before = m.version
    chainShaderPatch(m, { tag: 'dirty' })
    expect(m.version).toBeGreaterThan(before)
  })

  it('with a once-set it installs ONCE per material and says so', () => {
    const m = terrainLike()
    const once = new WeakSet<THREE.Material>()
    expect(chainShaderPatch(m, { tag: 'once', fragment: (s) => `${s}!` }, once)).toBe(true)
    expect(chainShaderPatch(m, { tag: 'once', fragment: (s) => `${s}!` }, once)).toBe(false)
    expect(compile(m).fragmentShader).toBe('F!')
    expect(m.customProgramCacheKey().match(/\|once/g)).toHaveLength(1)
    expect(once.has(m)).toBe(true)
  })

  it('without a once-set it does not guard (the caller owns a fresh material)', () => {
    const m = terrainLike()
    expect(chainShaderPatch(m, { tag: 'a' })).toBe(true)
    expect(chainShaderPatch(m, { tag: 'b' })).toBe(true)
  })

  it('chainBeforeCompile alone chains and dirties, and tags nothing', () => {
    const m = terrainLike()
    tagProgramCacheKey(m, 'kept')
    const before = m.version
    chainBeforeCompile(m, (shader) => {
      shader.fragmentShader += '+x'
    })
    // three's default key is the hook's own text, so only the tag TAIL is stable.
    expect(m.customProgramCacheKey().endsWith('|kept')).toBe(true)
    expect(m.customProgramCacheKey().split('|kept')).toHaveLength(2)
    expect(m.version).toBeGreaterThan(before)
    expect(compile(m).fragmentShader).toBe('F+x')
  })
})

describe('nobody adds a patch site without a tag', () => {
  /**
   * ONE door. After RC-1 every chained `onBeforeCompile` goes through
   * `chainShaderPatch` (tag REQUIRED by its type) or `chainBeforeCompile` (for
   * the one site that tags somewhere else, checked below), and both live in
   * `render/program-cache-key.ts`. So the guard is no longer "every file that
   * assigns also tags", which a single helper file would satisfy vacuously: it
   * is "NOBODY assigns the hook but the helper", with the exceptions named.
   *
   * Swept over all of `src/`, not `render` and `game` alone: the old guard's
   * widening (DEV-090) was about a patch nearly going in beside the material
   * it patches, and `src/` is where the next one could go.
   */
  const ALLOWED: Record<string, string> = {
    'render/program-cache-key.ts': 'the helper itself',
    'render/delegating-clone.ts':
      'a clone delegates to its BASE, which is tagged; the clone key delegates too (RC-2)',
  }

  /** Source with comments removed, so prose about the hook is not an assignment. */
  const code = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  /** A raw ASSIGNMENT, whatever the receiver is called. Not `==`, not a read. */
  const assignsHook = (src: string): boolean => /\.onBeforeCompile\s*=(?!=)/.test(code(src))

  const files = (): { rel: string; src: string }[] => {
    const root = path.join(process.cwd(), 'src')
    return (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        rel: f.split(path.sep).join('/'),
        src: fs.readFileSync(path.join(root, f), 'utf8'),
      }))
  }

  it('no file assigns onBeforeCompile raw except the helper and the documented delegations', () => {
    const offenders = files()
      .filter((f) => assignsHook(f.src) && !(f.rel in ALLOWED))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('and the detector is not vacuous: it flags a planted assignment and ignores prose', () => {
    expect(assignsHook('material.onBeforeCompile = (s) => {}')).toBe(true)
    expect(assignsHook('  clone.onBeforeCompile=(s, r) => {}')).toBe(true)
    expect(assignsHook('// material.onBeforeCompile = fn')).toBe(false)
    expect(assignsHook('/** clone.onBeforeCompile = fn */ const a = 1')).toBe(false)
    expect(assignsHook('if (a.onBeforeCompile === b) {}')).toBe(false)
    expect(assignsHook('const previous = material.onBeforeCompile')).toBe(false)
  })

  it('every allow-listed file really does assign (a stale entry is a hole)', () => {
    const byName = new Map(files().map((f) => [f.rel, f.src]))
    for (const rel of Object.keys(ALLOWED)) {
      expect(assignsHook(byName.get(rel) ?? ''), rel).toBe(true)
    }
  })

  it('a file that uses chainBeforeCompile (tagging elsewhere) also calls tagProgramCacheKey', () => {
    const offenders = files()
      .filter((f) => f.rel !== 'render/program-cache-key.ts')
      .filter((f) => /\bchainBeforeCompile\(/.test(code(f.src)))
      .filter((f) => !code(f.src).includes('tagProgramCacheKey('))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('and the door is really used: at least a dozen files go through chainShaderPatch', () => {
    const users = files().filter(
      (f) => f.rel !== 'render/program-cache-key.ts' && /\bchainShaderPatch\(/.test(code(f.src)),
    )
    expect(users.length).toBeGreaterThanOrEqual(12)
  })
})

describe('setDefineInPlace: one define, in place, in a fixed position (RC-7, DEV-194)', () => {
  const names = (m: THREE.Material): string[] => Object.keys(m.defines ?? {})

  it('turning a name on appends it; off deletes it and the survivors keep their order', () => {
    const m = new THREE.MeshStandardMaterial()
    m.defines = { STANDARD: '', A: '', B: '' }
    expect(setDefineInPlace(m, 'PIN', true)).toBe(true)
    expect(names(m)).toEqual(['STANDARD', 'A', 'B', 'PIN'])
    expect(setDefineInPlace(m, 'A', false)).toBe(true)
    expect(names(m)).toEqual(['STANDARD', 'B', 'PIN'])
  })

  it('is a function of the STATE, not the history: off and back on lands in one place', () => {
    const m = new THREE.MeshStandardMaterial()
    m.defines = { STANDARD: '', A: '' }
    setDefineInPlace(m, 'PIN', true)
    const first = names(m)
    setDefineInPlace(m, 'PIN', false)
    setDefineInPlace(m, 'PIN', true)
    expect(names(m)).toEqual(first)
  })

  it('edits the SAME object (fragment-gates keys its state on it) and reports no change when none', () => {
    const m = new THREE.MeshStandardMaterial()
    const before = m.defines
    expect(setDefineInPlace(m, 'PIN', true)).toBe(true)
    expect(m.defines).toBe(before)
    expect(setDefineInPlace(m, 'PIN', true)).toBe(false)
    expect(setDefineInPlace(m, 'GONE', false)).toBe(false)
    expect(m.defines).toBe(before)
  })

  it('creates the object only to turn a name ON; off on a define-less material makes none', () => {
    const m = new THREE.MeshBasicMaterial()
    expect(m.defines).toBeUndefined()
    expect(setDefineInPlace(m, 'PIN', false)).toBe(false)
    expect(m.defines).toBeUndefined()
    expect(setDefineInPlace(m, 'PIN', true)).toBe(true)
    expect(names(m)).toEqual(['PIN'])
  })
})
