// src/render/multiview.ts: draw both eyes in ONE pass with `OVR_multiview2`.
// DEV-986, behind `?multiview=1` (DEV-985 is the spike). Default OFF.
//
// ── What three 0.185.1 gives us, and what it does not ────────────────────
//
// `WebGLRenderer`'s `WebXRManager` builds a side-by-side `XRProjectionLayer`
// and draws the scene twice, once per eye camera of an `ArrayCamera`, each into
// its half of one framebuffer. Only `WebGPURenderer`'s `common/XRManager.js`
// asks for a `texture-array` layer. So this file is the WebGL path's multiview,
// built on hook points three already calls through PROPERTIES (never an edit to
// `node_modules/three`):
//
//   1. `renderer.xr.getBinding`: the binding's `createProjectionLayer` is
//      wrapped to ask for `textureType: 'texture-array'`. Both views then share
//      ONE colour texture and ONE depth texture, layers 0 and 1 (the spike,
//      `tools/perf/xr-multiview-spike.mjs`).
//   2. `renderer.setRenderTargetTextures`: three hands it the layer's textures
//      every frame. For the array layer we attach them to OUR framebuffer with
//      `framebufferTextureMultiviewOVR` (views 0 and 1) and give three that
//      framebuffer through `setRenderTargetFramebuffer`, the opaque-framebuffer
//      path three already has for an `XRWebGLLayer`. The XR target's `samples`
//      goes to 0: WebGL2 has no multisampled texture array, and the extension
//      that would render MSAA into one (`OCULUS_multiview`) is not exposed on
//      this Chrome (DEV-971's probe, and this file's probe on Chrome 155).
//   3. `renderer.xr.updateCamera`: after three has posed both eyes and built the
//      union camera, we write the per-eye matrices into one uniform buffer and
//      set `isArrayCamera` false on three's XR camera. `WebGLRenderer.render`
//      then draws the scene ONCE with the union camera (union frustum culling,
//      one render list, lights set up once) into the multiview framebuffer.
//
// ── How a program learns it is a multiview program ───────────────────────
//
// The eye target's texture gets its own COLOUR SPACE name,
// `ff2-multiview-srgb`, defined as an exact copy of three's sRGB entry (same
// primaries array, same transfer), so the GLSL three emits for it is the sRGB
// GLSL, character for character. three keys programs on the target's colour
// space (`getProgramCacheKeyParameters` pushes `outputColorSpace`) and swaps a
// material's program when it changes (`setProgram`'s `outputColorSpace`
// check), so one material drawn into the eye target and into, say, a shadow or
// mirror target gets a separate program for each, with no per-material edit and
// no `needsUpdate`. The same trick is how the canvas and every offscreen target
// already get separate programs today (`render/warm-up.ts`, DEV-239).
//
// The GLSL itself is rewritten where every program passes and nothing else can
// reach: `gl.shaderSource` on the renderer's own context, wrapped. When the
// target being compiled for is the eye target, `multiviewSource` adds the
// extension directive at the top (ANGLE refuses one after any other token,
// ESSL3: probed), the `num_views = 2` layout, a std140 uniform block of the
// per-eye matrices, and macros that turn three's camera uniforms into per-view
// reads. Every OTHER program's source is untouched, byte for byte.
//
// ── Why the per-eye term is "eye from centre" ────────────────────────────
//
// three computes `modelViewMatrix` and `normalMatrix` on the CPU, in double
// precision, against the camera it is drawing with, which is now the union
// camera. The macros multiply by `E = eyeView * inverse(centreView)`, a near-
// identity rigid transform (the eye's few centimetres from the union camera),
// rather than rebuilding `view * model` on the GPU in float32 at world
// coordinates of several kilometres. So:
//
//   modelViewMatrix -> E[view] * modelViewMatrix     (the eye's own, exactly)
//   viewMatrix      -> E[view] * viewMatrix
//   normalMatrix    -> mat3(E[view]) * normalMatrix  (E is rigid)
//   projectionMatrix-> the eye's own projection
//   cameraPosition  -> the eye's own world position
//
// Everything in view space is then in the EYE's space, as it is without
// multiview. three's light uniforms are not: `WebGLLights.setupView` puts
// directions and positions in the space of the camera it was given, the union
// camera. `multiviewSource` rewrites the four light reads in
// `lights_pars_begin` (directional and hemisphere directions, point and spot
// positions and the spot axis) through the same `E`. Rect-area lights are not
// rewritten: there are none in `src/`, and the module refuses quietly rather
// than guessing (see `fallbacks`).
//
// ── What multiview cannot do, and how each is handled ────────────────────
//
//   * Per-eye culling: the scene is culled once against three's union frustum
//     (`setProjectionFromUnion`), as the non-multiview path already builds its
//     render list once. `game/clouds.ts` culls its instances per pass and sees
//     the union camera as one camera, so it culls against the union too.
//   * Anything drawn into one eye on purpose (layer 1 or 2 alone): nothing in
//     `src/` is (`xr-eye-layers.test.ts`). The lens mask is on both eye layers
//     and asks `drawsBothEyes` (`render/lens-mask.ts`).
//   * MSAA: none (above). The pixel proof compares against `?aa=0`.
//   * A `RawShaderMaterial` or anything else without three's camera uniform
//     prelude cannot be rewritten; it is compiled unchanged, reported in
//     `fallbacks`, and its draw into the multiview framebuffer fails loudly.
//   * GPU timer queries: see `boot/gpu-timer.ts` (DEV-987).

import * as THREE from 'three'
import { setSessionWarmTarget } from './warm-up'

/** The eye target's colour space: three's sRGB under a name of our own. See the header. */
export const MULTIVIEW_COLOR_SPACE = 'ff2-multiview-srgb'

/** Defined in every multiview program, so a chunk can ask. */
export const MULTIVIEW_DEFINE = 'FF2_MULTIVIEW'

/** The std140 block both stages declare. */
export const MULTIVIEW_BLOCK = 'FF2Multiview'

/** What the rewrite puts first, after `#version`. */
export const MULTIVIEW_EXTENSION = '#extension GL_OVR_multiview2 : require'

const VERSION = '#version 300 es\n'

/**
 * The line every non-raw three program declares last among the camera uniforms,
 * in BOTH stages (`WebGLProgram.js` prefixVertex and prefixFragment). The
 * macros go straight after it, so the declarations above it stay real
 * uniforms (three still uploads them) and every use below it is per view.
 */
export const MULTIVIEW_ANCHOR = 'uniform bool isOrthographic;\n'

const VIEW = 'int(gl_ViewID_OVR)'

/** Float count of the block: two mat4, two mat4, two vec4. std140, no padding needed. */
export const MULTIVIEW_FLOATS = 16 * 2 + 16 * 2 + 4 * 2

const BLOCK = /* glsl */ `layout(std140) uniform ${MULTIVIEW_BLOCK} {
  mat4 ff2MvEyeFromCentre[2];
  mat4 ff2MvProjection[2];
  vec4 ff2MvCameraPosition[2];
};`

/**
 * Both stages. Self-referential macros are not re-expanded (ANGLE, probed), so
 * `viewMatrix` inside its own definition is the real uniform.
 *
 * ALL FIVE names in both stages. The fragment prefix declares only the first
 * two, but three's own fragment chunks read the others under a define
 * (`normal_fragment_maps` reads `normalMatrix` for an object-space normal map,
 * `transmission_fragment` reads `projectionMatrix`) and declare them in the
 * body, after where these macros would have turned the declaration into an
 * expression. So the fragment stage declares the three here, before its
 * macros, and `multiviewSource` drops any such declaration from the body. An
 * unused uniform costs nothing; a vertex-stage uniform with the same name and
 * type is the same uniform (both stages are `highp`, three's precision).
 */
const SHARED = /* glsl */ `#define ${MULTIVIEW_DEFINE}
${BLOCK}
#define viewMatrix (ff2MvEyeFromCentre[${VIEW}] * viewMatrix)
#define cameraPosition (ff2MvCameraPosition[${VIEW}].xyz)
#define projectionMatrix ff2MvProjection[${VIEW}]
#define modelViewMatrix (ff2MvEyeFromCentre[${VIEW}] * modelViewMatrix)
#define normalMatrix (mat3(ff2MvEyeFromCentre[${VIEW}]) * normalMatrix)
#define ff2EyePos(p) ((ff2MvEyeFromCentre[${VIEW}] * vec4((p), 1.0)).xyz)
#define ff2EyeDir(d) (mat3(ff2MvEyeFromCentre[${VIEW}]) * (d))
`

/** The vertex prefix declares these already; the fragment one does not. */
const FRAGMENT_DECLARATIONS = /* glsl */ `uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
`

/** A vertex-stage layout; the fragment stage only reads the id. */
const VERTEX_LAYOUT = `layout(num_views = 2) in;
`

/**
 * three's light reads, from the union camera's view space into the eye's.
 * Each pair is (the function it lives in, the line), so a function that is
 * present without its line means three moved it, and that throws.
 */
export const MULTIVIEW_LIGHT_REWRITES: readonly (readonly [string, string, string])[] = [
  [
    'void getDirectionalLightInfo(',
    'light.direction = directionalLight.direction;',
    'light.direction = ff2EyeDir( directionalLight.direction );',
  ],
  [
    'void getPointLightInfo(',
    'vec3 lVector = pointLight.position - geometryPosition;',
    'vec3 lVector = ff2EyePos( pointLight.position ) - geometryPosition;',
  ],
  [
    'void getSpotLightInfo(',
    'vec3 lVector = spotLight.position - geometryPosition;',
    'vec3 lVector = ff2EyePos( spotLight.position ) - geometryPosition;',
  ],
  [
    'void getSpotLightInfo(',
    'float angleCos = dot( light.direction, spotLight.direction );',
    'float angleCos = dot( light.direction, ff2EyeDir( spotLight.direction ) );',
  ],
  [
    'vec3 getHemisphereLightIrradiance(',
    'float dotNL = dot( normal, hemiLight.direction );',
    'float dotNL = dot( normal, ff2EyeDir( hemiLight.direction ) );',
  ],
]

/** The names the prelude turns into per-view expressions. */
export const MULTIVIEW_MACRO_NAMES = [
  'viewMatrix',
  'cameraPosition',
  'projectionMatrix',
  'modelViewMatrix',
  'normalMatrix',
] as const

const CAMERA_DECLARATION = new RegExp(
  `(uniform\\s+(?:mat4|mat3|vec3)\\s+(?:${MULTIVIEW_MACRO_NAMES.join('|')})\\s*;)`,
  'g',
)

const PARAMETER = new RegExp(
  `\\b(?:mat4|mat3|vec3)\\s+(${MULTIVIEW_MACRO_NAMES.join('|')})\\s*[,)]`,
  'g',
)

/**
 * A FUNCTION PARAMETER spelled like a camera uniform would be macro-expanded
 * into an expression, which is a syntax error: three's own `common` chunk has
 * `transformNormalByInverseViewMatrix( in vec3 normal, in mat4 viewMatrix )`
 * (found by the first probe run, every lit program failed to compile). Inside
 * such a function the name means the PARAMETER, so it is renamed there, in the
 * signature and the body, to `ff2Param_<name>`; the caller's argument is still
 * expanded at the call site, so the function receives the per-eye value.
 */
export const renameShadowingParameters = (body: string): string => {
  let out = body
  // One function at a time, from the first match: a renamed parameter no
  // longer matches, so this ends, and no offset is reused after an edit.
  for (let guard = 0; guard < 64; guard++) {
    PARAMETER.lastIndex = 0
    const m = PARAMETER.exec(out)
    if (m === null) return out
    const name = m[1] as string
    const open = out.lastIndexOf('(', m.index)
    const brace = out.indexOf('{', m.index)
    let end = -1
    let depth = 0
    for (let i = brace; brace >= 0 && i < out.length; i++) {
      if (out[i] === '{') depth++
      else if (out[i] === '}' && --depth === 0) {
        end = i + 1
        break
      }
    }
    if (open < 0 || end < 0) {
      throw new Error(`multiview: a parameter named ${name} outside a function body`)
    }
    const fn = out.slice(open, end).replace(new RegExp(`\\b${name}\\b`, 'g'), `ff2Param_${name}`)
    out = `${out.slice(0, open)}${fn}${out.slice(end)}`
  }
  throw new Error('multiview: more than 64 shadowing parameters')
}

/**
 * One stage's source, as three is about to hand it to GL, made a multiview
 * program. Pure, so the unit test composes it with real three programs.
 *
 * **Throws** when the source is not a three program it understands (no
 * `#version 300 es` first, no camera prelude) or when three moved a light read:
 * a program that compiled without its per-eye terms would put the right eye's
 * picture in the left eye, quietly.
 */
export const multiviewSource = (source: string, stage: 'vertex' | 'fragment'): string => {
  if (!source.startsWith(VERSION)) {
    throw new Error('multiview: source does not start with "#version 300 es"')
  }
  const at = source.indexOf(MULTIVIEW_ANCHOR)
  if (at < 0) {
    throw new Error(
      `multiview: no "${MULTIVIEW_ANCHOR.trim()}" in this ${stage} source (a RawShaderMaterial?)`,
    )
  }
  const cut = at + MULTIVIEW_ANCHOR.length
  let body = renameShadowingParameters(source.slice(cut))
  for (const [fn, from, to] of MULTIVIEW_LIGHT_REWRITES) {
    if (!body.includes(fn)) continue
    if (!body.includes(from)) {
      throw new Error(`multiview: three's ${fn}...) no longer reads "${from}"`)
    }
    body = body.replaceAll(from, to)
  }
  // A body declaration of a camera name follows the macros, so it would expand
  // into an expression: the prelude declares every one a stage reads instead.
  body = body.replace(CAMERA_DECLARATION, '// (ff2 multiview: declared in the prelude) $1')
  const prelude =
    stage === 'vertex' ? `${VERTEX_LAYOUT}${SHARED}` : `${FRAGMENT_DECLARATIONS}${SHARED}`
  return `${VERSION}${MULTIVIEW_EXTENSION}\n${source.slice(VERSION.length, cut)}${prelude}${body}`
}

let defined = false

/** Register the eye target's colour space with three. Idempotent. */
export const defineMultiviewColorSpace = (): void => {
  if (defined) return
  const cm = THREE.ColorManagement as unknown as {
    spaces: Record<string, object>
    define: (spaces: Record<string, object>) => void
  }
  const srgb = cm.spaces[THREE.SRGBColorSpace]
  if (!srgb) throw new Error('multiview: three has no sRGB colour space entry')
  // A shallow copy: the SAME primaries array, so three's gamut check
  // (`workingPrimaries === encodingPrimaries`, by reference) emits no matrix.
  cm.define({ [MULTIVIEW_COLOR_SPACE]: { ...srgb } })
  defined = true
}

const _centreInverse = new THREE.Matrix4()
const _eyeFromCentre = new THREE.Matrix4()
const _position = new THREE.Vector3()

/** The two eyes and the camera three draws them with, as this module needs them. */
export interface MultiviewEyes {
  /** The union (or any rigid) camera the scene is drawn and culled with. */
  readonly centre: THREE.Camera
  readonly left: THREE.Camera
  readonly right: THREE.Camera
}

/**
 * Pack the block: `E = eyeView * centreWorld`, each eye's projection, each
 * eye's world position. Matrices must be current (`matrixWorld`,
 * `matrixWorldInverse`), which three's `updateCamera` guarantees for the XR
 * cameras.
 */
export const packMultiviewBlock = (eyes: MultiviewEyes, out: Float32Array): Float32Array => {
  _centreInverse.copy(eyes.centre.matrixWorld)
  const list = [eyes.left, eyes.right]
  for (let i = 0; i < 2; i++) {
    const eye = list[i] as THREE.Camera
    _eyeFromCentre.multiplyMatrices(eye.matrixWorldInverse, _centreInverse)
    out.set(_eyeFromCentre.elements, 16 * i)
    out.set(eye.projectionMatrix.elements, 32 + 16 * i)
    _position.setFromMatrixPosition(eye.matrixWorld)
    out[64 + 4 * i] = _position.x
    out[64 + 4 * i + 1] = _position.y
    out[64 + 4 * i + 2] = _position.z
    out[64 + 4 * i + 3] = 1
  }
  return out
}

/**
 * True when `camera` is three's XR camera drawing BOTH eyes in one pass. For an
 * `onBeforeRender` that asks "is this an eye" (`render/lens-mask.ts`): under
 * multiview the answer is the union camera, which this module turns from an
 * array camera into a single one for exactly the length of the session.
 */
export const drawsBothEyes = (
  xr: { readonly isPresenting: boolean; getCamera(): unknown },
  camera: unknown,
): boolean => {
  if (!xr.isPresenting) return false
  const xrCamera = xr.getCamera() as { isArrayCamera?: boolean }
  return camera === xrCamera && xrCamera.isArrayCamera === false
}

/** What `__ff2.multiview()` reports. */
export interface MultiviewReport {
  /** `?multiview=1` was given (the module is only installed then). */
  readonly requested: true
  /** `OVR_multiview2` on this context. */
  readonly extension: boolean
  /** The current session's layer is a texture array and draws go through it. */
  readonly active: boolean
  /** Sessions that got a texture-array layer, and sessions that asked and did not. */
  readonly sessions: number
  readonly refused: number
  /** Multiview programs that reached GL, i.e. bound their block. */
  readonly programs: number
  /**
   * Multiview vertex sources rewritten WHILE presenting: programs built in the
   * session rather than by the warm-up. A compile in the air costs frames, so
   * this is the warm-up's report card (DEV-239's lesson, for this key).
   */
  readonly compiledPresenting: number
  /** And before any session: the warm-up's (`render/warm-up.ts`, `setSessionWarmTarget`). */
  readonly compiledBefore: number
  /** Frames whose per-eye block was written. */
  readonly frames: number
  /** The framebuffer status the first attach read, by name. */
  readonly framebuffer: string | null
  /** Every source the rewrite refused, as `<reason>`, deduplicated. */
  readonly fallbacks: readonly string[]
}

export interface Multiview {
  report(): MultiviewReport
  /**
   * Compile for, and draw into, `target` as the multiview eye target: its
   * texture takes the multiview colour space and its framebuffer is `fb`. For
   * the probe (`render/multiview-probe.ts`), which renders the same scene both
   * ways in one JS turn; the XR path does the same thing to three's own target.
   */
  useTarget(target: THREE.WebGLRenderTarget, fb: WebGLFramebuffer): void
  /** Write the per-eye block for these eyes. The XR path calls it every frame. */
  writeEyes(eyes: MultiviewEyes): void
  /** `ext.framebufferTextureMultiviewOVR` on both attachments of `fb`; the GL status by name. */
  attach(fb: WebGLFramebuffer, color: WebGLTexture, depth: WebGLTexture | null): string
  /** The session is drawing through the multiview layer now. Free to call per frame. */
  active(): boolean
  /** The XR layer's colour texture this frame (both eyes), or null when not presenting through it. */
  texture(): WebGLTexture | null
  dispose(): void
}

interface MultiviewExt {
  framebufferTextureMultiviewOVR(
    target: number,
    attachment: number,
    texture: WebGLTexture | null,
    level: number,
    baseViewIndex: number,
    numViews: number,
  ): void
  readonly FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR: number
}

/** The renderer methods three declares in JS but `@types/three` does not. */
interface ExternalTargets {
  setRenderTargetTextures(
    target: THREE.WebGLRenderTarget,
    color?: WebGLTexture | null,
    depth?: WebGLTexture | null,
  ): void
  setRenderTargetFramebuffer(target: THREE.WebGLRenderTarget, fb: WebGLFramebuffer | null): void
}

interface ProjectionLayerLike {
  readonly textureArrayLength?: number
}

interface BindingLike {
  createProjectionLayer(init: Record<string, unknown>): ProjectionLayerLike
}

/**
 * Install multiview on `renderer`. Call once, right after the renderer is
 * built and before any session; `boot/app.ts` does, only under `?multiview=1`.
 * With the pin absent nothing in this file runs and nothing is wrapped.
 */
export const installMultiview = (renderer: THREE.WebGLRenderer): Multiview => {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const ext = gl.getExtension('OVR_multiview2') as MultiviewExt | null
  defineMultiviewColorSpace()

  const external = renderer as unknown as ExternalTargets
  // The warm-up compiles the session's programs under the loading curtain
  // (DEV-239); a multiview session's are these, so it gets their key. Without
  // the extension the session will be side by side, at the canvas's key.
  const warmTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 0 })
  ;(warmTarget as { isXRRenderTarget?: boolean }).isXRRenderTarget = true
  warmTarget.texture.colorSpace = MULTIVIEW_COLOR_SPACE
  if (ext) setSessionWarmTarget(warmTarget)
  const fallbacks = new Set<string>()
  let sessions = 0
  let refused = 0
  let programs = 0
  let compiledPresenting = 0
  let compiledBefore = 0
  let frames = 0
  let firstStatus: string | null = null
  let arrayLayer = false

  // ── the uniform block: one buffer, one binding point, every program ─────
  //
  // The LAST binding point, so three's own `UniformsGroup` allocator (which
  // counts up from 0) never meets it.
  const bindingPoint = (gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) as number) - 1
  const block = new Float32Array(MULTIVIEW_FLOATS)
  const ubo = gl.createBuffer()
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
  gl.bufferData(gl.UNIFORM_BUFFER, block.byteLength, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.UNIFORM_BUFFER, null)
  gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, ubo)
  gl.bindBuffer(gl.UNIFORM_BUFFER, null)

  const writeEyes = (eyes: MultiviewEyes): void => {
    packMultiviewBlock(eyes, block)
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, block)
    gl.bindBuffer(gl.UNIFORM_BUFFER, null)
    // Rebound every frame, in case anything took the point (nothing should).
    gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPoint, ubo)
    gl.bindBuffer(gl.UNIFORM_BUFFER, null)
    frames++
  }

  // ── the GLSL: rewritten at `shaderSource`, only for the eye target ──────
  const compilingForEyes = (): boolean =>
    renderer.getRenderTarget()?.texture.colorSpace === MULTIVIEW_COLOR_SPACE
  const rewritten = new WeakSet<WebGLShader>()
  const unbound = new WeakSet<WebGLProgram>()
  const shaderSource = gl.shaderSource.bind(gl)
  const attachShader = gl.attachShader.bind(gl)
  const useProgram = gl.useProgram.bind(gl)
  gl.shaderSource = (shader: WebGLShader, source: string): void => {
    if (compilingForEyes()) {
      const stage =
        gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
      try {
        shaderSource(shader, multiviewSource(source, stage))
        rewritten.add(shader)
        if (stage === 'vertex' && renderer.xr.isPresenting) compiledPresenting++
        else if (stage === 'vertex') compiledBefore++
        return
      } catch (e) {
        const name = /#define SHADER_NAME (.*)/.exec(source)?.[1] ?? '(unnamed)'
        const reason = `${name}: ${(e as Error).message}`
        if (!fallbacks.has(reason)) console.warn(`multiview: ${reason}`)
        fallbacks.add(reason)
      }
    }
    shaderSource(shader, source)
  }
  gl.attachShader = (program: WebGLProgram, shader: WebGLShader): void => {
    attachShader(program, shader)
    if (rewritten.has(shader)) unbound.add(program)
  }
  // The block is bound to our point on the program's FIRST use, which three
  // makes only after it has checked the link (`WebGLProgram.getUniforms`), so
  // the index query here never waits on a parallel compile.
  gl.useProgram = (program: WebGLProgram | null): void => {
    useProgram(program)
    if (program !== null && unbound.has(program)) {
      unbound.delete(program)
      const index = gl.getUniformBlockIndex(program, MULTIVIEW_BLOCK)
      if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, index, bindingPoint)
      programs++
    }
  }

  // ── the framebuffer ─────────────────────────────────────────────────────
  const statusName = (status: number): string => {
    if (status === gl.FRAMEBUFFER_COMPLETE) return 'COMPLETE'
    if (status === gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT) return 'INCOMPLETE_ATTACHMENT'
    if (status === gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT) return 'MISSING_ATTACHMENT'
    if (status === gl.FRAMEBUFFER_UNSUPPORTED) return 'UNSUPPORTED'
    if (ext && status === ext.FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR)
      return 'INCOMPLETE_VIEW_TARGETS'
    return `0x${status.toString(16)}`
  }
  const depthAttachment = gl.getContextAttributes()?.stencil
    ? gl.DEPTH_STENCIL_ATTACHMENT
    : gl.DEPTH_ATTACHMENT
  const attach = (
    fb: WebGLFramebuffer,
    color: WebGLTexture,
    depth: WebGLTexture | null,
  ): string => {
    if (!ext) return 'NO_EXTENSION'
    // Through three's state cache, so its idea of the bound framebuffer stays true.
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fb)
    ext.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, color, 0, 0, 2)
    ext.framebufferTextureMultiviewOVR(gl.DRAW_FRAMEBUFFER, depthAttachment, depth, 0, 0, 2)
    if (firstStatus !== null) return firstStatus
    firstStatus = statusName(gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER))
    return firstStatus
  }
  const useTarget = (target: THREE.WebGLRenderTarget, fb: WebGLFramebuffer): void => {
    target.samples = 0
    target.texture.colorSpace = MULTIVIEW_COLOR_SPACE
    external.setRenderTargetFramebuffer(target, fb)
  }

  // ── the XR hooks ────────────────────────────────────────────────────────
  const xr = renderer.xr
  const xrFb = gl.createFramebuffer()
  let lastColor: WebGLTexture | null = null
  let lastDepth: WebGLTexture | null = null
  const patchedBindings = new WeakSet<object>()
  const getBinding = xr.getBinding.bind(xr)
  xr.getBinding = () => {
    const binding = getBinding() as unknown as BindingLike | null
    if (binding && !patchedBindings.has(binding)) {
      patchedBindings.add(binding)
      const create = binding.createProjectionLayer.bind(binding)
      binding.createProjectionLayer = (init) => {
        if (ext) {
          try {
            const layer = create({ ...init, textureType: 'texture-array' })
            if (layer.textureArrayLength === 2) {
              arrayLayer = true
              sessions++
              return layer
            }
            fallbacks.add(`layer: textureArrayLength ${layer.textureArrayLength}`)
          } catch (e) {
            fallbacks.add(`layer: ${(e as Error).message}`)
          }
          refused++
        }
        arrayLayer = false
        return create(init)
      }
    }
    return binding as unknown as XRWebGLBinding
  }
  const setRenderTargetTextures = external.setRenderTargetTextures.bind(renderer)
  external.setRenderTargetTextures = (target, color, depth) => {
    if (!arrayLayer || !(target as { isXRRenderTarget?: boolean }).isXRRenderTarget || !color) {
      setRenderTargetTextures(target, color, depth)
      return
    }
    if (color !== lastColor || (depth ?? null) !== lastDepth) {
      attach(xrFb as WebGLFramebuffer, color, depth ?? null)
      lastColor = color
      lastDepth = depth ?? null
    }
    useTarget(target, xrFb as WebGLFramebuffer)
  }
  const updateCamera = xr.updateCamera.bind(xr)
  xr.updateCamera = (camera) => {
    updateCamera(camera)
    if (!arrayLayer || !xr.isPresenting) return
    const xrCamera = xr.getCamera()
    const [left, right] = xrCamera.cameras
    if (!left || !right) return
    // `WebGLRenderer.render` now draws the scene once, with this camera.
    const single = xrCamera as { isArrayCamera: boolean }
    single.isArrayCamera = false
    writeEyes({ centre: xrCamera, left, right })
  }
  const onSessionEnd = (): void => {
    arrayLayer = false
    lastColor = null
    lastDepth = null
    const array = xr.getCamera() as { isArrayCamera: boolean }
    array.isArrayCamera = true
  }
  xr.addEventListener('sessionend', onSessionEnd)

  return {
    report: () =>
      Object.freeze({
        requested: true as const,
        extension: ext !== null,
        active: arrayLayer && xr.isPresenting,
        sessions,
        refused,
        programs,
        compiledPresenting,
        compiledBefore,
        frames,
        framebuffer: firstStatus,
        fallbacks: Object.freeze([...fallbacks]),
      }),
    useTarget,
    writeEyes,
    attach,
    active: () => arrayLayer && xr.isPresenting,
    texture: () => (arrayLayer && xr.isPresenting ? lastColor : null),
    dispose() {
      setSessionWarmTarget(null)
      warmTarget.dispose()
      xr.removeEventListener('sessionend', onSessionEnd)
      gl.deleteBuffer(ubo)
      gl.deleteFramebuffer(xrFb)
    },
  }
}
