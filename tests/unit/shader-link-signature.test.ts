// tests/unit/shader-link-signature.test.ts — the strings `shader-link.spec.ts`
// matches are the strings three actually prints. DEV-324.
//
// ── Why this is in node and not only in the browser ──────────────────────
//
// The e2e spec's console half classifies lines by EXACT PREFIX, because three's
// benign `Program Info Log` warnings (HLSL `X4122` precision notes, logged by
// programs that linked) share `THREE.WebGLProgram:` with the failure, and app
// lines mention shaders, so anything looser than the full prefix calls benign
// lines failures. An exact
// prefix has the opposite weakness: if three rewords its message, the prefix
// stops matching and the console half goes quiet — and a quiet detector reads
// as a pass. So the prefixes are held to three's own build here, the way
// `xr-eye-layers.test.ts` and `program-key.test.ts` hold their claims about
// three: *a test that compares two of your own devices has not tested either.*
//
// The GL half of the spec (`LINK_STATUS` over `renderer.info.programs`) does
// not depend on any string, and §2 pins the premise that makes it necessary:
// three reports a failure only on a program's first DRAW.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PARAMETER_FIELDS } from '../e2e/fixtures/program-key'
import {
  classifyConsole,
  collapseRepeats,
  describeConsoleFailure,
  describeFailedProgram,
  firstErrorLine,
  PROGRAM_INFO_LOG_PREFIX,
  SHADER_ERROR_PREFIX,
  sessionKeyedPhysical,
  USE_PROGRAM_NOT_VALID,
} from '../e2e/fixtures/shader-link'
import { REPO as ROOT } from './helpers/repo-root'
import { walkTree } from './helpers/source-tree'

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** The body of `onFirstUse` in three's `WebGLProgram`, up to its clean-up. */
const onFirstUseBody = (build: string): string => {
  const start = build.indexOf('function onFirstUse( self ) {')
  const end = build.indexOf('cachedUniforms = new WebGLUniforms( gl, program );', start)
  if (start === -1 || end === -1) return ''
  return build.slice(start, end)
}

describe('§1 the console signatures are three’s own', () => {
  it('a failed link is `error( "WebGLProgram: Shader Error …" )`, and error() prefixes THREE.', () => {
    // Inside the `it`: disk work at collection time is the `describe.skipIf`
    // trap (CLAUDE.md).
    const body = onFirstUseBody(read('node_modules/three/build/three.module.js'))
    expect(body, 'found onFirstUse').not.toBe('')
    // The failure branch, and the order inside it: the LINK_STATUS test, then
    // the call. If three ever reports from somewhere else, read the new code.
    const literal = 'WebGLProgram: Shader Error '
    const linkTest = body.indexOf('gl.getProgramParameter( program, gl.LINK_STATUS ) === false')
    const call = body.indexOf(`'${literal}'`)
    expect(linkTest, 'the LINK_STATUS test').toBeGreaterThan(-1)
    expect(call, 'the Shader Error message').toBeGreaterThan(linkTest)
    expect(body.slice(linkTest, call)).toContain('error(')

    // `error()` lives in three.core.js and prepends `THREE.` to its first arg.
    const core = read('node_modules/three/build/three.core.js')
    const errorFn = core.slice(core.indexOf('function error( ...params ) {'))
    expect(errorFn.slice(0, 400)).toContain("const message = 'THREE.' + params.shift();")
    expect(errorFn.slice(0, 1200)).toContain('console.error( message, ...params );')

    expect(SHADER_ERROR_PREFIX).toBe(`THREE.${literal.trimEnd()}`)
  })

  it('a program that LINKED with a non-empty log is a `warn`, and it is the benign one', () => {
    const body = onFirstUseBody(read('node_modules/three/build/three.module.js'))
    // `} else if ( programLog !== '' ) {` — the branch AFTER the failure branch.
    const literal = 'WebGLProgram: Program Info Log:'
    const benign = body.indexOf("} else if ( programLog !== '' ) {")
    const warnCall = body.indexOf(`warn( '${literal}', programLog );`)
    expect(benign, 'the linked-with-a-log branch').toBeGreaterThan(-1)
    expect(warnCall).toBeGreaterThan(benign)
    expect(PROGRAM_INFO_LOG_PREFIX).toBe(`THREE.${literal}`)
  })

  it('nothing in src/ redirects three’s console or turns its checking off', () => {
    // Either would silence the console half without failing anything. The GL
    // sweep would still catch a failure, but the spec asserts the console half
    // is live and would go red for the wrong reason, a long way from here.
    const offenders: string[] = []
    for (const p of walkTree(path.join(ROOT, 'src'), {
      match: (name) => /\.(ts|js)$/.test(name),
    })) {
      const src = fs.readFileSync(p, 'utf8')
      if (/setConsoleFunction\s*\(|checkShaderErrors\s*=/.test(src))
        offenders.push(path.relative(ROOT, p))
    }
    expect(offenders).toEqual([])
  })
})

describe('§2 three reports a link failure only when a program is first DRAWN', () => {
  it('onFirstUse runs from getUniforms/getAttributes, and compile() calls neither', () => {
    // This is the premise that makes the spec's GL sweep necessary rather than
    // belt-and-braces. `render/warm-up.ts` builds most programs through
    // `renderer.compile()` and some — a session's variants on a flat run — are
    // never drawn at all, so a failure in one of them never reaches the console.
    const build = read('node_modules/three/build/three.module.js')
    const calls = [...build.matchAll(/onFirstUse\( this \)/g)].length
    expect(calls, 'onFirstUse is invoked from exactly two places').toBe(2)
    const getters = build.slice(build.indexOf('this.getUniforms = function () {'))
    expect(getters.slice(0, 400)).toContain('onFirstUse( this );')
    const compile = build.slice(
      build.indexOf('this.compile = function ( scene, camera, targetScene = null ) {'),
      build.indexOf('this.compileAsync = function'),
    )
    expect(compile.length, 'found WebGLRenderer.compile').toBeGreaterThan(100)
    expect(compile).toContain('prepareMaterial(')
    expect(compile).not.toContain('getUniforms')
    expect(compile).not.toContain('getAttributes')
  })
})

describe('§3 the classifier matches what fails and nothing that merely mentions a shader', () => {
  // Shaped like three's real output: `error()` joins nothing — the whole report
  // is ONE string, first line the status, then the material, then each half.
  const FAILURE =
    `${SHADER_ERROR_PREFIX} 1282 - VALIDATE_STATUS false\n\n` +
    'Material Name: \nMaterial Type: MeshStandardMaterial\n\n' +
    'Program Info Log: Vertex shader is not compiled.\n\n' +
    "VERTEX\n\nERROR: 0:512: 'uSunTopXf' : undeclared identifier\n" +
    "ERROR: 0:512: '' : compilation terminated\n\n  507: {\n> 512:   vFf2SunWorld = ..."
  // ANGLE's D3D11 back end, on a program that LINKED: the first line of the
  // one this box printed on the title, hangar and int_01 arms of DEV-324's
  // run, verbatim. It shares `THREE.WebGLProgram:` with the failure.
  const BENIGN =
    `${PROGRAM_INFO_LOG_PREFIX} (210,81-129): warning X4122: sum of 0.996094 and ` +
    '-2.98545e-017 cannot be represented accurately in double precision'

  it('three’s failure report is a link failure', () => {
    expect(classifyConsole(FAILURE)).toBe('link-failure')
  })

  it('Chrome’s own complaint about binding it is a link failure too', () => {
    expect(classifyConsole(`WebGL: INVALID_OPERATION: ${USE_PROGRAM_NOT_VALID}`)).toBe(
      'link-failure',
    )
  })

  it('a linked program’s X4122 note is benign, though it comes from the same WebGLProgram', () => {
    expect(BENIGN.startsWith('THREE.WebGLProgram:')).toBe(true)
    expect(classifyConsole(BENIGN)).toBe('program-info-log')
  })

  it('app lines and driver notes that mention shaders are not failures', () => {
    for (const text of [
      'warm-up: first draw of the title screen in 812 ms — 104 programs, 90 geometries',
      'cloud-look: shader patched for 3 materials',
      '[.WebGL-0x7a3c]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels',
      // Chrome's cap line, which a broken program provokes and a healthy
      // context can too. Not a failure by itself; the lines before it were.
      'WebGL: too many errors, no more errors will be reported to the console for this context.',
    ]) {
      expect(classifyConsole(text), text).not.toBe('link-failure')
    }
  })

  it('collapses a per-draw complaint to one line with a count', () => {
    const bind = `WebGL: INVALID_OPERATION: ${USE_PROGRAM_NOT_VALID}`
    expect(collapseRepeats(['a', bind, bind, 'b', bind])).toEqual(['a', `×3 ${bind}`, 'b'])
  })

  it('names the program: material type and the compiler’s first ERROR', () => {
    const line = describeConsoleFailure(FAILURE)
    expect(line).toContain('MeshStandardMaterial')
    expect(line).toContain("ERROR: 0:512: 'uSunTopXf' : undeclared identifier")
    expect(firstErrorLine('\n  fine\nERROR: 0:3: x\nERROR: 0:4: y')).toBe('ERROR: 0:3: x')
  })

  it('a swept failure says which half, who draws it, and whether the console could see it', () => {
    const line = describeFailedProgram({
      id: 37,
      name: '',
      type: 'MeshStandardMaterial',
      cacheKey: 'not,a,parseable,key',
      programLog: 'Vertex shader is not compiled.',
      vertexLog: "ERROR: 0:512: 'uSunTopXf' : undeclared identifier",
      fragmentLog: '',
      drawn: false,
      usedBy: ['chunk_3_4 / terrain'],
    })
    expect(line).toContain('program #37 MeshStandardMaterial')
    expect(line).toContain('NEVER drawn')
    expect(line).toContain('chunk_3_4 / terrain')
    expect(line).toContain("VERTEX ERROR: 0:512: 'uSunTopXf' : undeclared identifier")
    expect(line).not.toContain('FRAGMENT')
  })

  it('names the module by its tag chain, not by the patch function’s source', () => {
    // three's default `customProgramCacheKey()` is `onBeforeCompile.toString()`,
    // so a real key's last field is the patch SOURCE and then `|tag|tag`. The
    // first RED run printed that source, forty lines per program.
    const source = '(shader, renderer) => {\n\tprevious?.call(material, shader, renderer);\n}'
    const line = describeFailedProgram({
      id: 22,
      name: '',
      type: 'MeshPhysicalMaterial',
      cacheKey: key({
        shaderId: 'physical',
        out: 'srgb-linear',
        tag: `${source}|unity-fog|sun-height`,
      }),
      programLog: '',
      vertexLog: '',
      fragmentLog: "ERROR: 0:2211: 'uFogRadial' : undeclared identifier",
      drawn: true,
      usedBy: [],
    })
    expect(line).toContain('unity-fog|sun-height')
    expect(line).not.toContain('previous?.call')
    expect(line).toContain("FRAGMENT ERROR: 0:2211: 'uFogRadial'")
  })
})

/**
 * A cache key laid out the way `getProgramCacheKey` joins it: shader id, the
 * defines, the 48 parameters (`precision` first, `outputColorSpace` second),
 * two masks, the renderer's colour space, the custom tag.
 */
const key = (o: { shaderId: string; out: string; tag?: string }): string =>
  [
    o.shaderId,
    'STANDARD',
    '',
    'highp',
    o.out,
    ...PARAMETER_FIELDS.slice(2).map(() => ''),
    '0',
    '0',
    'srgb',
    o.tag ?? '',
  ].join(',')

describe('§4 the session arm’s premise separates the two bindings', () => {
  it('counts `physical` programs at the canvas colour space, and nothing else', () => {
    expect(
      sessionKeyedPhysical([
        key({ shaderId: 'physical', out: 'srgb' }),
        key({ shaderId: 'physical', out: 'srgb-linear' }),
        key({ shaderId: 'basic', out: 'srgb' }),
      ]),
    ).toBe(1)
  })
})
