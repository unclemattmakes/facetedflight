// tests/unit/multiview.test.ts: the multiview rewrite and its per-eye block.
// DEV-986.
//
// What a node test can establish, with three's own build as the oracle:
//   * the premises `render/multiview.ts` stands on are still in three's build:
//     both program prefixes end their camera uniforms with the anchor, the
//     version line is first, the program key carries the target's colour space
//     and `setProgram` swaps a program when it changes;
//   * the rewrite puts the extension directive before every other token
//     (ANGLE refuses it later in ESSL3: probed on Chrome 155), the view layout
//     in the vertex stage only, and rewrites every light read three makes in
//     view space, on the real physical program with its includes resolved;
//   * the packed block puts a point where the eye's own matrices put it.
//
// What it cannot: whether a program COMPILES and LINKS, and whether the eyes
// match. That is the browser's (`shader-link.spec.ts` with
// `SHADER_LINK_MULTIVIEW=1`, and `__ff2.multiviewProbe()`).

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { MULTIVIEW_SHIPPED, parseMultiviewPin } from '@/boot/quality-pin'
import {
  defineMultiviewColorSpace,
  drawsBothEyes,
  MULTIVIEW_ANCHOR,
  MULTIVIEW_COLOR_SPACE,
  MULTIVIEW_EXTENSION,
  MULTIVIEW_FLOATS,
  MULTIVIEW_LIGHT_REWRITES,
  MULTIVIEW_MACRO_NAMES,
  multiviewSource,
  packMultiviewBlock,
  renameShadowingParameters,
} from '@/render/multiview'
import { REPO as ROOT } from './helpers/repo-root'

const resolve = (src: string): string =>
  src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name: string) => {
    const chunk = (THREE.ShaderChunk as Record<string, string>)[name]
    if (chunk === undefined) throw new Error(`no chunk ${name}`)
    return resolve(chunk)
  })

/**
 * A program the way `WebGLProgram` assembles a non-raw one: the version, its
 * GLSL 3 defines, precision, the camera uniforms ending in the anchor, then
 * the resolved body. The lines between are not three's verbatim; the order and
 * the anchor are, and the premise test below reads those out of the build.
 */
const program = (stage: 'vertex' | 'fragment', body: string): string => {
  const camera =
    stage === 'vertex'
      ? 'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nuniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\n'
      : 'uniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\n'
  const head =
    stage === 'vertex'
      ? '#define attribute in\n#define varying out\n'
      : '#define varying in\nlayout(location = 0) out highp vec4 pc_fragColor;\n'
  return `#version 300 es\n${head}precision highp float;\n#define SHADER_NAME MeshPhysicalMaterial\n${camera}${MULTIVIEW_ANCHOR}${resolve(body)}`
}

const physical = THREE.ShaderLib.physical

describe('the premises, read out of three', () => {
  const build = (): string =>
    fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

  it('ends BOTH camera preludes with the anchor, after which the body follows', () => {
    const src = build()
    // prefixVertex and prefixFragment each declare it once, as an array entry.
    const entries = src.split(`'${MULTIVIEW_ANCHOR.trim()}',`).length - 1
    expect(entries).toBe(2)
    expect(src).toContain(`versionString = '#version 300 es\\n';`)
  })

  it('keys a program on the target colour space and swaps it when that changes', () => {
    const src = build()
    expect(src).toContain('array.push( parameters.outputColorSpace );')
    expect(src).toContain('materialProperties.outputColorSpace !== colorSpace')
    expect(src).toContain(
      'currentRenderTarget.isXRRenderTarget === true ? currentRenderTarget.texture.colorSpace',
    )
  })

  it('draws an array camera per eye, and anything else once', () => {
    expect(build()).toContain('if ( camera.isArrayCamera ) {')
  })
})

describe('multiviewSource', () => {
  for (const stage of ['vertex', 'fragment'] as const) {
    it(`${stage}: the extension directive is the first thing after #version`, () => {
      const src = program(
        stage,
        stage === 'vertex' ? physical.vertexShader : physical.fragmentShader,
      )
      const out = multiviewSource(src, stage)
      const lines = out.split('\n')
      expect(lines[0]).toBe('#version 300 es')
      expect(lines[1]).toBe(MULTIVIEW_EXTENSION)
      expect(out.split(MULTIVIEW_EXTENSION).length - 1).toBe(1)
    })

    it(`${stage}: the camera uniforms stay declared and every use after them is per view`, () => {
      const src = program(
        stage,
        stage === 'vertex' ? physical.vertexShader : physical.fragmentShader,
      )
      const out = multiviewSource(src, stage)
      const at = out.indexOf(MULTIVIEW_ANCHOR)
      // The declarations above the anchor are untouched.
      expect(out.slice(0, at)).toContain('uniform mat4 viewMatrix;')
      expect(out.slice(0, at)).not.toContain('ff2Mv')
      const after = out.slice(at)
      expect(after).toContain('#define viewMatrix (ff2MvEyeFromCentre[')
      expect(after).toContain('#define cameraPosition (ff2MvCameraPosition[')
      expect(after).toContain('#define FF2_MULTIVIEW')
      // All five names are per view in BOTH stages: three's fragment chunks
      // read `normalMatrix` and `projectionMatrix` under a define.
      expect(after).toContain('#define projectionMatrix ff2MvProjection[')
      expect(after).toContain('#define modelViewMatrix (ff2MvEyeFromCentre[')
      expect(after).toContain('#define normalMatrix (mat3(ff2MvEyeFromCentre[')
      if (stage === 'vertex') {
        expect(after).toContain('layout(num_views = 2) in;')
      } else {
        // num_views is a vertex-stage layout; the fragment stage only reads the id.
        expect(after).not.toContain('num_views')
        // and declares the uniforms its prefix does not, BEFORE the macros.
        const macros = out.indexOf('#define FF2_MULTIVIEW')
        for (const d of ['uniform mat4 projectionMatrix;', 'uniform mat3 normalMatrix;']) {
          expect(out.indexOf(d), d).toBeGreaterThan(at)
          expect(out.indexOf(d), d).toBeLessThan(macros)
        }
      }
    })
  }

  it('rewrites every view-space light read of the physical fragment', () => {
    const src = program('fragment', physical.fragmentShader)
    for (const [fn, from] of MULTIVIEW_LIGHT_REWRITES) {
      expect(src, `the physical fragment has ${fn}`).toContain(fn)
      expect(src).toContain(from)
    }
    const out = multiviewSource(src, 'fragment')
    for (const [, from, to] of MULTIVIEW_LIGHT_REWRITES) {
      expect(out).not.toContain(from)
      expect(out).toContain(to)
    }
    // Independent of the list above: every read of a light's view-space
    // direction or position in the body goes through the eye transform.
    const body = out.slice(out.indexOf('#define FF2_MULTIVIEW'))
    for (const field of [
      'directionalLight.direction',
      'pointLight.position',
      'spotLight.position',
      'spotLight.direction',
      'hemiLight.direction',
    ]) {
      const uses = body.split(field).length - 1
      expect(uses, `${field} is read`).toBeGreaterThan(0)
      const wrapped =
        body.split(`ff2EyeDir( ${field}`).length - 1 + body.split(`ff2EyePos( ${field}`).length - 1
      expect(wrapped, `every read of ${field} is per eye`).toBe(uses)
    }
  })

  it('throws when three moved a light read, rather than compiling a wrong eye', () => {
    const src = program('fragment', physical.fragmentShader).replace(
      'light.direction = directionalLight.direction;',
      'light.direction = normalize( directionalLight.direction );',
    )
    expect(() => multiviewSource(src, 'fragment')).toThrow(/getDirectionalLightInfo/)
  })

  // The first probe run: three's `common` chunk takes `in mat4 viewMatrix` as a
  // PARAMETER, the macro turned it into an expression, and every lit program
  // failed with "syntax error" at that line.
  for (const stage of ['vertex', 'fragment'] as const) {
    it(`${stage}: no declaration after the prelude is spelled like a camera uniform`, () => {
      const src = program(
        stage,
        stage === 'vertex' ? physical.vertexShader : physical.fragmentShader,
      )
      expect(src, 'the premise: three declares such a parameter').toMatch(/in mat4 viewMatrix\b/)
      const out = multiviewSource(src, stage)
      const body = out.slice(out.indexOf('#define FF2_MULTIVIEW'))
      const defined = MULTIVIEW_MACRO_NAMES.filter((n) => body.includes(`#define ${n} `))
      expect(defined.length).toBe(5)
      // Comment lines aside: a dropped declaration is kept as a comment.
      const live = body
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n')
      for (const name of defined) {
        expect(live, name).not.toMatch(new RegExp(`\\b(?:mat4|mat3|vec3|vec4)\\s+${name}\\b`))
      }
      if (stage === 'fragment') {
        // The premise of the drop: the physical fragment declares one in its body.
        expect(body).toContain(
          '// (ff2 multiview: declared in the prelude) uniform mat4 projectionMatrix;',
        )
      }
      expect(body).toContain('in mat4 ff2Param_viewMatrix')
    })
  }

  it('renames a shadowing parameter in its own function and nowhere else', () => {
    const body = [
      'vec3 a( in vec3 n, in mat4 viewMatrix ) {',
      '  if (true) { return ( vec4( n, 0.0 ) * viewMatrix ).xyz; }',
      '  return n;',
      '}',
      'vec3 b() { return ( viewMatrix * vec4( 1.0 ) ).xyz; }',
    ].join('\n')
    const out = renameShadowingParameters(body)
    expect(out).toContain('in mat4 ff2Param_viewMatrix )')
    expect(out).toContain('* ff2Param_viewMatrix ).xyz; }')
    expect(out).toContain('vec3 b() { return ( viewMatrix * vec4( 1.0 ) ).xyz; }')
  })

  it('refuses a source with no camera prelude (a RawShaderMaterial)', () => {
    expect(() => multiviewSource('#version 300 es\nvoid main() {}\n', 'vertex')).toThrow(
      /RawShaderMaterial/,
    )
    expect(() => multiviewSource('void main() {}\n', 'vertex')).toThrow(/#version/)
  })
})

describe('the per-eye block', () => {
  const eye = (x: number, yaw: number, fov: number): THREE.PerspectiveCamera => {
    const c = new THREE.PerspectiveCamera(fov, 1, 0.08, 6000)
    c.position.set(1000 + x, 50, -2000)
    c.rotation.set(0.1, 0.4 + yaw, 0.05, 'YXZ')
    c.updateMatrixWorld()
    c.updateProjectionMatrix()
    return c
  }

  it('puts a point where the eye itself would, through the union camera', () => {
    const left = eye(-0.032, 0.02, 95)
    const right = eye(0.032, -0.02, 97)
    const centre = eye(0, 0, 120)
    centre.position.z += 0.03
    centre.updateMatrixWorld()
    const block = packMultiviewBlock({ centre, left, right }, new Float32Array(MULTIVIEW_FLOATS))
    const p = new THREE.Vector3(1003, 49, -2010)
    for (const [i, cam] of [left, right].entries()) {
      const e = new THREE.Matrix4().fromArray(block, 16 * i)
      const proj = new THREE.Matrix4().fromArray(block, 32 + 16 * i)
      // What the shader computes: P[v] * E[v] * (centreView * p).
      const viaCentre = p
        .clone()
        .applyMatrix4(centre.matrixWorldInverse)
        .applyMatrix4(e)
        .applyMatrix4(proj)
      // What the eye's own matrices give.
      const direct = p
        .clone()
        .applyMatrix4(cam.matrixWorldInverse)
        .applyMatrix4(cam.projectionMatrix)
      expect(viaCentre.distanceTo(direct)).toBeLessThan(1e-4)
      const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld)
      expect(block[64 + 4 * i]).toBeCloseTo(pos.x, 2)
      expect(block[64 + 4 * i + 1]).toBeCloseTo(pos.y, 2)
      expect(block[64 + 4 * i + 2]).toBeCloseTo(pos.z, 2)
    }
  })

  it('maps a view-space light direction from the centre to the eye', () => {
    // A directional light's uniform is in the union camera's view space; the
    // rewrite multiplies it by mat3(E). Against the eye's own view rotation.
    const left = eye(-0.032, 0.05, 95)
    const right = eye(0.032, -0.05, 95)
    const centre = eye(0, 0, 120)
    const block = packMultiviewBlock({ centre, left, right }, new Float32Array(MULTIVIEW_FLOATS))
    const world = new THREE.Vector3(0.3, 0.8, -0.2).normalize()
    for (const [i, cam] of [left, right].entries()) {
      const e = new THREE.Matrix4().fromArray(block, 16 * i)
      const inCentre = world.clone().transformDirection(centre.matrixWorldInverse)
      const rewritten = inCentre.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(e))
      const inEye = world.clone().transformDirection(cam.matrixWorldInverse)
      expect(rewritten.distanceTo(inEye)).toBeLessThan(1e-5)
    }
  })
})

describe('the eye target colour space', () => {
  it('is three sRGB under another name: same primaries array, same transfer', () => {
    defineMultiviewColorSpace()
    const cm = THREE.ColorManagement as unknown as {
      spaces: Record<string, { primaries: unknown }>
    }
    expect(THREE.ColorManagement.getTransfer(MULTIVIEW_COLOR_SPACE as THREE.ColorSpace)).toBe(
      THREE.SRGBTransfer,
    )
    expect(cm.spaces[MULTIVIEW_COLOR_SPACE]?.primaries).toBe(
      cm.spaces[THREE.SRGBColorSpace]?.primaries,
    )
  })
})

describe('drawsBothEyes', () => {
  it('is true only for the XR camera drawing as one camera, while presenting', () => {
    const xrCamera = new THREE.ArrayCamera()
    const xr = { isPresenting: true, getCamera: () => xrCamera }
    expect(drawsBothEyes(xr, xrCamera)).toBe(false)
    ;(xrCamera as { isArrayCamera: boolean }).isArrayCamera = false
    expect(drawsBothEyes(xr, xrCamera)).toBe(true)
    expect(drawsBothEyes(xr, new THREE.PerspectiveCamera())).toBe(false)
    expect(drawsBothEyes({ ...xr, isPresenting: false }, xrCamera)).toBe(false)
  })
})

describe('?multiview=', () => {
  it('is the shipped default unless asked, and a typo is the shipped default', () => {
    expect(MULTIVIEW_SHIPPED).toBe(true)
    expect(parseMultiviewPin(null)).toBe(MULTIVIEW_SHIPPED)
    expect(parseMultiviewPin('1')).toBe(true)
    expect(parseMultiviewPin('on')).toBe(true)
    expect(parseMultiviewPin('0')).toBe(false)
    expect(parseMultiviewPin('off')).toBe(false)
    const warned: string[] = []
    expect(parseMultiviewPin('yes', (m) => warned.push(m))).toBe(MULTIVIEW_SHIPPED)
    expect(warned).toHaveLength(1)
  })
})
