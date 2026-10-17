// src/render/eye-buffer.ts: an eye buffer the app owns, so the resolution can
// move in a headset. DEV-994 (the buffer), DEV-995 (its MSAA), DEV-996 (the
// controller, `render/eye-scale.ts`), DEV-997 (the pins). Behind
// `?eyeBuffer=1`; absent, nothing here is installed.
//
// ── Why ──────────────────────────────────────────────────────────────────
//
// On desktop Chrome the eye's size is fixed when the session starts: three
// builds the projection layer at `framebufferScaleFactor` and never again, and
// `requestViewportScale` is a stored no-op on every OpenXR device
// (`docs/plan/XR-PERF-VS-THREE.md` §3.4, §4.3). The worn traces say the missed
// frames scale with the eye's pixels (`eval-frame-trace.md`, traces 5 and 6).
// So the scene is drawn into a target of OURS, `s` times the layer's size, and
// one pass upsamples it into three's XR target. `s` can then move every frame.
//
// ── Three has no hop to reuse here ───────────────────────────────────────
//
// `WebGLRenderer.render` composites through `WebGLOutput` only when the
// renderer was built with an `outputBufferType` other than `UnsignedByteType`
// (`WebGLRenderer.js:553`, `:1631`). `render/renderer.ts` builds the default,
// so `output` is null and three draws a session straight into the layer. And
// `WebGLOutput.begin` resizes its target to the XR target (`:174` of that
// file), which is the one thing this needs not to happen. So this is the hop.
//
// ── How it hooks three (no edit to `node_modules/three`) ─────────────────
//
//  1. `renderer.setRenderTargetTextures` / `setRenderTargetFramebuffer`: three
//     calls one of them every XR frame with its XR target, before our frame
//     callback. That names the target by IDENTITY (nothing else is matched by a
//     flag), and on first sight its `samples` goes to 0: three would otherwise
//     build a 4x MSAA colour and depth pair at the layer's size that nothing
//     draws into but the upsample. On the `XRWebGLLayer` path the framebuffer
//     is the runtime's and this changes nothing.
//  2. `renderer.render`: a render whose bound target is the XR target, while
//     presenting, is redirected. The eye cameras' viewports are scaled by `s`
//     (each eye keeps its own camera, layers 1 and 2, its own projection),
//     the scene is drawn into the eye target, three resolves its MSAA, and
//     the upsample draws into the XR target with `xr.enabled` held false for
//     that one call (so three does not swap in the XR camera for it),
//     `autoClear` false (it overwrites every pixel) and `info.autoReset` false
//     (so the frame's draw count is the scene's plus one).
//
// ── The eye target ───────────────────────────────────────────────────────
//
// `isXRRenderTarget = true` and the renderer's output colour space, exactly
// like three's own XR target, because three keys programs on both
// (`WebGLPrograms.js:180`, `:212`): every material compiles to the program it
// already had in a session, the shader encodes sRGB itself, and the warm-up's
// session programs (DEV-239) still match. Its storage is forced to `RGBA8`
// (`texture.internalFormat`) because three gives an sRGB render-target TEXTURE
// `SRGB8_ALPHA8` (`setupFrameBufferTexture`), which encodes again on write and
// decodes on read: a round trip through a second 8-bit curve that moved 75 %
// of an eye's pixels by up to 4 levels (the negative arm of
// `eye-buffer.spec.ts`, 2026-10-16). The multisampled renderbuffer is already
// linear for an XR target (`WebGLTextures.js:2120`). So the bytes are the
// bytes the layer would have held, and the upsample copies them without a
// colour conversion.
//
// It is allocated ONCE at the layer's size and drawn in its lower-left
// `s`-sized corner: `width` and `height` are set to the live size so three's
// MSAA resolve (`updateMultisampleRenderTarget`, which blits `0, 0, width,
// height`) resolves only what was drawn, and a scissor keeps the clear there
// too. Moving `s` therefore allocates nothing: no hitch in a headset.
//
// ── What each eye still sees ─────────────────────────────────────────────
//
// The eye-dither origin (`render/eye-dither.ts`) is read from three's current
// viewport at upload time, which is now the scaled eye's, so each eye seeds from
// its own pixel as before. The lens mask is in clip space. Every per-eye
// uniform three uploads comes from the eye camera it is drawing, untouched
// here. The viewports are left SCALED after the draw until three resets them at
// the next frame, so the trace's `vp_w` column (`boot/perf-surface.ts`) reads
// the pixels the frame was actually drawn at.
//
// ── What it does not do ──────────────────────────────────────────────────
//
//  * Depth: the layer's depth is not written. Chrome's projection layer sets
//    `ignoreDepthValues` (XR-PERF-VS-THREE §3.7), so nothing reads it on the
//    target. A runtime that reads depth would get none; `report().depthIgnored`
//    says which kind this session has.
//  * Multiview: not combined. `boot/app.ts` installs one or the other.
//  * Pixel-sized effects scale with `s` (a line width or point size in
//    pixels draws `1/s` wider after the upsample). None is used in a session.

import * as THREE from 'three'
import {
  createEyeScaleState,
  EYE_SCALE_CEILING,
  EYE_SCALE_PIN_MIN,
  type EyeScaleChange,
  eyeScaleOf,
  resetEyeScaleState,
  stepEyeScale,
} from './eye-scale'

/** Samples the eye target can take (`?eyeMsaa=`). */
export type EyeMsaa = 0 | 2 | 4

export interface EyeBufferOptions {
  /** Samples. Null: what three would have given the layer, 4 on an antialiased context, else 0. */
  readonly msaa?: EyeMsaa | null
  /** A fixed scale (`?eyeScale=`), or null for the controller. */
  readonly scale?: number | null
  /** Where a change is logged. Default `console.info`. */
  readonly log?: (message: string) => void
}

/** A rectangle in pixels, `Vector4` order: x, y, width, height. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

/**
 * One eye's viewport at scale `s`. Origin and size are each rounded, so eyes
 * that sit side by side at `E` and `2E` stay side by side at `round(E s)`, and
 * `s = 1` is the rectangle itself, bit for bit.
 */
export const scaleRect = (v: Rect, s: number): Rect =>
  s === 1
    ? { x: v.x, y: v.y, z: v.z, w: v.w }
    : {
        x: Math.round(v.x * s),
        y: Math.round(v.y * s),
        z: Math.max(1, Math.round(v.z * s)),
        w: Math.max(1, Math.round(v.w * s)),
      }

/** The live area the scaled eyes cover, from the origin. */
export const liveSize = (rects: readonly Rect[]): { width: number; height: number } => {
  let width = 1
  let height = 1
  for (const r of rects) {
    width = Math.max(width, r.x + r.z)
    height = Math.max(height, r.y + r.w)
  }
  return { width, height }
}

/** Clamp a scale into what the eye buffer can draw. */
export const clampEyeScale = (s: number): number =>
  Number.isFinite(s) ? Math.min(EYE_SCALE_CEILING, Math.max(EYE_SCALE_PIN_MIN, s)) : 1

/**
 * The upsample. One triangle over the whole XR target; each pixel finds its
 * eye's destination rectangle and samples the same place in that eye's source
 * rectangle, clamped half a texel inside it so bilinear filtering never reads
 * the other eye. At `s = 1` the ratio is exactly 1, every sample lands on a
 * texel centre and the copy is exact.
 */
export const BLIT_VERTEX = /* glsl */ `precision highp float;
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const BLIT_FRAGMENT = /* glsl */ `precision highp float;
uniform sampler2D tEye;
uniform vec4 uDst0;
uniform vec4 uDst1;
uniform vec4 uSrc0;
uniform vec4 uSrc1;
uniform vec2 uTexel;
out vec4 ff2EyeColour;
void main() {
  vec2 p = gl_FragCoord.xy;
  bool second = p.x >= uDst1.x && p.x < uDst1.x + uDst1.z && p.y >= uDst1.y && p.y < uDst1.y + uDst1.w;
  vec4 d = second ? uDst1 : uDst0;
  vec4 s = second ? uSrc1 : uSrc0;
  vec2 q = s.xy + (p - d.xy) * (s.zw / d.zw);
  q = clamp(q, s.xy + 0.5, s.xy + s.zw - 0.5);
  ff2EyeColour = texture(tEye, q * uTexel);
}
`

/** One eye's comparison in `probe()`. */
export interface EyeDiff {
  readonly eye: number
  readonly pixels: number
  readonly maxDiff: number
  /** Pixels whose largest RGBA channel difference is over 0, 2 and 8. */
  readonly over0: number
  readonly over2: number
  readonly over8: number
  /** The first few differing pixels, `x,y` in the eye (GL rows, bottom up). */
  readonly at: readonly string[]
}

export interface EyeBufferProbe {
  /** The XR target's size and each eye's rectangle in it. */
  readonly width: number
  readonly height: number
  readonly eyes: readonly Rect[]
  /** The eye buffer arm's scale and samples. */
  readonly scale: number
  readonly msaa: number
  /**
   * What the direct arm drew into: three's XR target itself (single-sampled),
   * or, with eye MSAA, a twin of it built from the same parameters at that
   * MSAA, because three's target is single-sampled under the eye buffer.
   */
  readonly reference: 'xr-target' | 'msaa-twin'
  /** Draw calls of each arm (the direct arm, the eye-buffer arm with its upsample). */
  readonly calls: { readonly direct: number; readonly eyeBuffer: number }
  readonly glError: { readonly direct: number; readonly eyeBuffer: number; readonly again: number }
  /** Direct against the eye buffer, per eye, RGBA. */
  readonly compare: readonly EyeDiff[]
  /**
   * The CONTROL: the direct arm drawn again after the eye-buffer arm, against
   * the first. Whatever moves inside one JS turn (nothing should) shows here,
   * and `compare` is read against it.
   */
  readonly control: readonly EyeDiff[]
  /** The direct arm's left eye against its right: the eyes must differ, or `compare` is vacuous. */
  readonly parallax: EyeDiff | null
  /** [direct, eye buffer] as PNG data URLs when asked, the whole XR target, top row first. */
  readonly png?: readonly string[]
}

export interface EyeBufferReport {
  readonly requested: true
  /** Drawing through the eye buffer now: presenting, and three's XR target seen. */
  readonly active: boolean
  /** The scale in force, and the pin (null when the controller decides). */
  readonly scale: number
  readonly pinned: number | null
  /** The eye target's samples asked, as GL built them (null before the first frame), and three's XR target's. */
  readonly msaa: number
  readonly glSamples: number | null
  readonly xrTargetSamples: number | null
  /** The layer's size, the eye target's allocation, and the live area last drawn. */
  readonly layer: { readonly width: number; readonly height: number } | null
  readonly live: { readonly width: number; readonly height: number } | null
  /** Frames drawn through it, and the controller's view of the session. */
  readonly frames: number
  readonly controllerFrames: number
  readonly misses: number
  readonly ignored: number
  readonly backoff: number
  /** Every change this session, newest last (capped). */
  readonly changes: readonly EyeScaleChange[]
  /** The base layer says the runtime ignores depth (Chrome); null before the first frame. */
  readonly depthIgnored: boolean | null
}

export interface EyeBuffer {
  /** One frame for the controller: the XR frame period and the display rate. No-op flat or pinned. */
  frame(periodSeconds: number, displayHz: number): void
  /** Pin a scale live (`__ff2.eyeBuffer(0.8)`), or hand it back to the controller with null. */
  pin(scale: number | null): EyeBufferReport
  report(): EyeBufferReport
  /**
   * On the next XR frame, draw the stage three times in one turn: as three
   * does (into the XR target, or its MSAA twin, see `reference`), through the
   * eye buffer at `scale` (default 1), and as three does again (the control);
   * read each back and compare the eyes. Rejects when not presenting.
   * DEV-994's and DEV-995's pixel proof.
   */
  probe(options?: { scale?: number; png?: boolean }): Promise<EyeBufferProbe>
  dispose(): void
}

interface ExternalTargets {
  setRenderTargetTextures(
    target: THREE.WebGLRenderTarget,
    color?: WebGLTexture | null,
    depth?: WebGLTexture | null,
  ): void
  setRenderTargetFramebuffer(target: THREE.WebGLRenderTarget, fb: WebGLFramebuffer | null): void
}

type XrTargetLike = THREE.WebGLRenderTarget & { isXRRenderTarget?: boolean }

const CHANGES_KEPT = 64

const readTarget = (
  gl: WebGL2RenderingContext,
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  width: number,
  height: number,
): Uint8Array => {
  renderer.setRenderTarget(target)
  const out = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
  return out
}

const diffRect = (
  eye: number,
  a: Uint8Array,
  aX: number,
  b: Uint8Array,
  bX: number,
  stride: number,
  rect: Rect,
): EyeDiff => {
  let maxDiff = 0
  let over0 = 0
  let over2 = 0
  let over8 = 0
  const at: string[] = []
  for (let y = rect.y; y < rect.y + rect.w; y++) {
    for (let x = 0; x < rect.z; x++) {
      const i = (y * stride + aX + x) * 4
      const j = (y * stride + bX + x) * 4
      let worst = 0
      for (let c = 0; c < 4; c++) {
        const d = Math.abs((a[i + c] as number) - (b[j + c] as number))
        if (d > worst) worst = d
      }
      if (worst > maxDiff) maxDiff = worst
      if (worst > 0 && at.length < 8) at.push(`${x},${y}`)
      if (worst > 0) over0++
      if (worst > 2) over2++
      if (worst > 8) over8++
    }
  }
  return { eye, pixels: rect.z * rect.w, maxDiff, over0, over2, over8, at }
}

const toPng = (rgba: Uint8Array, w: number, h: number): string => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    image.data.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * Install the eye buffer on `renderer`. Once, before any session;
 * `render/renderer.ts` does, under `?eyeBuffer=1` only.
 */
export const installEyeBuffer = (
  renderer: THREE.WebGLRenderer,
  options: EyeBufferOptions = {},
): EyeBuffer => {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const xr = renderer.xr
  const external = renderer as unknown as ExternalTargets
  const attributes = gl.getContextAttributes()
  const msaa: number = options.msaa ?? (attributes?.antialias ? 4 : 0)
  const log = options.log ?? ((m: string) => console.info(m))
  let pinned: number | null =
    options.scale === null || options.scale === undefined ? null : clampEyeScale(options.scale)

  const state = createEyeScaleState()
  const changes: EyeScaleChange[] = []
  let xrTarget: XrTargetLike | null = null
  let eyeTarget: THREE.WebGLRenderTarget | null = null
  let allocWidth = 0
  let glSamples: number | null = null
  let allocHeight = 0
  let frames = 0
  let busy = false
  let depthIgnored: boolean | null = null
  let lastFrame: unknown = null
  let live: { width: number; height: number } | null = null
  const original: THREE.Vector4[] = [new THREE.Vector4(), new THREE.Vector4()]
  let originalCount = 0
  let pendingProbe: {
    scale: number
    png: boolean
    resolve: (p: EyeBufferProbe) => void
    reject: (e: unknown) => void
  } | null = null

  // ── the upsample ────────────────────────────────────────────────────────
  const uniforms = {
    tEye: { value: null as THREE.Texture | null },
    uDst0: { value: new THREE.Vector4() },
    uDst1: { value: new THREE.Vector4() },
    uSrc0: { value: new THREE.Vector4() },
    uSrc1: { value: new THREE.Vector4() },
    uTexel: { value: new THREE.Vector2() },
  }
  const blitMaterial = new THREE.RawShaderMaterial({
    name: 'eye-buffer-upsample',
    glslVersion: THREE.GLSL3,
    vertexShader: BLIT_VERTEX,
    fragmentShader: BLIT_FRAGMENT,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  })
  const blitGeometry = new THREE.BufferGeometry()
  blitGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
  )
  const blitMesh = new THREE.Mesh(blitGeometry, blitMaterial)
  blitMesh.name = 'eye-buffer-upsample'
  blitMesh.frustumCulled = false
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  // Compiled now, so a session's first frame does not link it in the air.
  renderer.compile(blitMesh, blitCamera)

  const scaleInForce = (): number => pinned ?? eyeScaleOf(state)

  /**
   * A target built the way the eye target is: three's XR-target program key,
   * RGBA8 storage under an sRGB name, `msaa` samples. Returns it with the
   * samples GL actually built (three clamps to MAX_SAMPLES).
   */
  const buildTarget = (
    width: number,
    height: number,
    name: string,
  ): { target: THREE.WebGLRenderTarget; samples: number } => {
    const target = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: renderer.outputColorSpace as THREE.ColorSpace,
      depthBuffer: attributes?.depth !== false,
      stencilBuffer: attributes?.stencil === true,
      samples: msaa,
      resolveDepthBuffer: false,
      resolveStencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    // See the header: three's program key, and RGBA8 storage under an sRGB name.
    ;(target as XrTargetLike).isXRRenderTarget = true
    target.texture.internalFormat = 'RGBA8'
    target.texture.name = name
    renderer.initRenderTarget(target)
    const colour = (
      renderer.properties.get(target) as { __webglColorRenderbuffer?: WebGLRenderbuffer[] }
    ).__webglColorRenderbuffer?.[0]
    let samples = 0
    if (colour) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, colour)
      samples = gl.getRenderbufferParameter(gl.RENDERBUFFER, gl.RENDERBUFFER_SAMPLES) as number
      gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    }
    return { target, samples }
  }

  const ensureTarget = (width: number, height: number): THREE.WebGLRenderTarget => {
    if (eyeTarget && allocWidth === width && allocHeight === height) return eyeTarget
    eyeTarget?.dispose()
    const built = buildTarget(width, height, 'eye-buffer')
    const target = built.target
    glSamples = built.samples
    target.scissorTest = true
    eyeTarget = target
    allocWidth = width
    allocHeight = height
    uniforms.tEye.value = target.texture
    uniforms.uTexel.value.set(1 / width, 1 / height)
    return target
  }

  // ── 1. naming three's XR target ─────────────────────────────────────────
  const seen = (target: THREE.WebGLRenderTarget): void => {
    const t = target as XrTargetLike
    if (t.isXRRenderTarget !== true || t === eyeTarget || t === xrTarget) return
    xrTarget = t
    // Before three's first `setRenderTarget` on it builds the buffers.
    t.samples = 0
    const layer = xr.getBaseLayer() as { ignoreDepthValues?: boolean } | null
    depthIgnored = typeof layer?.ignoreDepthValues === 'boolean' ? layer.ignoreDepthValues : null
  }
  const setRenderTargetTextures = external.setRenderTargetTextures.bind(renderer)
  external.setRenderTargetTextures = (target, color, depth) => {
    if (xr.isPresenting) seen(target)
    setRenderTargetTextures(target, color, depth)
  }
  const setRenderTargetFramebuffer = external.setRenderTargetFramebuffer.bind(renderer)
  external.setRenderTargetFramebuffer = (target, fb) => {
    if (xr.isPresenting) seen(target)
    setRenderTargetFramebuffer(target, fb)
  }

  // ── 2. the draw ─────────────────────────────────────────────────────────
  const render = renderer.render.bind(renderer)

  /** The eye cameras' viewports as three set them THIS frame. */
  const eyeRects = (): Rect[] => {
    const cameras = (xr.getCamera() as THREE.ArrayCamera).cameras
    const frame = xr.getFrame()
    if (frame !== lastFrame || originalCount !== cameras.length) {
      lastFrame = frame
      originalCount = cameras.length
      for (let i = 0; i < cameras.length && i < 2; i++) {
        const v = (cameras[i] as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport
        if (v) (original[i] as THREE.Vector4).copy(v)
      }
    }
    const out: Rect[] = []
    for (let i = 0; i < Math.min(2, cameras.length); i++) {
      const v = original[i] as THREE.Vector4
      out.push({ x: v.x, y: v.y, z: v.z, w: v.w })
    }
    return out
  }

  const throughEyeBuffer = (scene: THREE.Object3D, camera: THREE.Camera, s: number): void => {
    const target = xrTarget as XrTargetLike
    const cameras = (xr.getCamera() as THREE.ArrayCamera).cameras
    const dst = eyeRects()
    if (dst.length === 0) {
      render(scene, camera)
      return
    }
    const eye = ensureTarget(target.width, target.height)
    const src = dst.map((r) => scaleRect(r, s))
    for (let i = 0; i < src.length; i++) {
      const v = (cameras[i] as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport
      const r = src[i] as Rect
      v?.set(r.x, r.y, r.z, r.w)
    }
    live = liveSize(src)
    // The live corner: three resolves `0, 0, width, height` and clears inside the scissor.
    eye.width = live.width
    eye.height = live.height
    eye.viewport.set(0, 0, live.width, live.height)
    eye.scissor.set(0, 0, live.width, live.height)
    renderer.setRenderTarget(eye)
    render(scene, camera)

    const d0 = dst[0] as Rect
    const d1 = dst[1] ?? d0
    const s0 = src[0] as Rect
    const s1 = src[1] ?? s0
    uniforms.uDst0.value.set(d0.x, d0.y, d0.z, d0.w)
    uniforms.uDst1.value.set(d1.x, d1.y, d1.z, d1.w)
    uniforms.uSrc0.value.set(s0.x, s0.y, s0.z, s0.w)
    uniforms.uSrc1.value.set(s1.x, s1.y, s1.z, s1.w)
    renderer.setRenderTarget(target)
    const xrEnabled = xr.enabled
    const autoClear = renderer.autoClear
    const autoReset = renderer.info.autoReset
    xr.enabled = false
    renderer.autoClear = false
    renderer.info.autoReset = false
    try {
      render(blitMesh, blitCamera)
    } finally {
      xr.enabled = xrEnabled
      renderer.autoClear = autoClear
      renderer.info.autoReset = autoReset
    }
    frames++
  }

  const runProbe = (
    scene: THREE.Object3D,
    camera: THREE.Camera,
    probe: NonNullable<typeof pendingProbe>,
  ): void => {
    const target = xrTarget as XrTargetLike
    const width = target.width
    const height = target.height
    const eyes = eyeRects()
    const cameras = (xr.getCamera() as THREE.ArrayCamera).cameras
    const info = renderer.info
    const autoReset = info.autoReset
    // Single-sampled, the direct arm draws into three's XR target itself. With
    // MSAA it cannot (three's target is single-sampled under the eye buffer),
    // so it draws into a TWIN of three's XR target at the eye MSAA: built from
    // the same parameters, drawn and resolved by three's own `render`.
    const twin = msaa > 0 ? buildTarget(width, height, 'eye-buffer-probe-twin').target : null
    const direct = (): { pixels: Uint8Array; calls: number; error: number } => {
      for (let i = 0; i < eyes.length; i++) {
        const r = eyes[i] as Rect
        ;(cameras[i] as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport?.set(
          r.x,
          r.y,
          r.z,
          r.w,
        )
      }
      info.reset()
      renderer.setRenderTarget(twin ?? target)
      render(scene, camera)
      const calls = info.render.calls
      const error = gl.getError()
      const pixels = new Uint8Array(width * height * 4)
      if (twin) renderer.readRenderTargetPixels(twin, 0, 0, width, height, pixels)
      else pixels.set(readTarget(gl, renderer, target, width, height))
      renderer.setRenderTarget(target)
      return { pixels, calls, error }
    }
    info.autoReset = false
    try {
      const first = direct()
      info.reset()
      throughEyeBuffer(scene, camera, probe.scale)
      const eyeCalls = info.render.calls
      const eyeError = gl.getError()
      const viaEye = readTarget(gl, renderer, target, width, height)
      // The control: the direct arm again, so the pair brackets the eye arm in time.
      const again = direct()
      const compare = eyes.map((r, i) => diffRect(i, first.pixels, r.x, viaEye, r.x, width, r))
      const control = eyes.map((r, i) =>
        diffRect(i, first.pixels, r.x, again.pixels, r.x, width, r),
      )
      const e0 = eyes[0]
      const e1 = eyes[1]
      const parallax =
        e0 && e1 && e0.z === e1.z && e0.w === e1.w
          ? diffRect(-1, first.pixels, e0.x, first.pixels, e1.x, width, e0)
          : null
      probe.resolve({
        width,
        height,
        eyes,
        scale: probe.scale,
        msaa,
        reference: twin ? 'msaa-twin' : 'xr-target',
        calls: { direct: first.calls, eyeBuffer: eyeCalls },
        glError: { direct: first.error, eyeBuffer: eyeError, again: again.error },
        compare,
        control,
        parallax,
        ...(probe.png
          ? { png: [toPng(first.pixels, width, height), toPng(viaEye, width, height)] }
          : {}),
      })
    } finally {
      info.autoReset = autoReset
      twin?.dispose()
    }
  }

  renderer.render = (scene: THREE.Object3D, camera: THREE.Camera): void => {
    if (busy || !xr.isPresenting || xrTarget === null || renderer.getRenderTarget() !== xrTarget) {
      render(scene, camera)
      return
    }
    busy = true
    try {
      const probe = pendingProbe
      if (probe) {
        pendingProbe = null
        try {
          runProbe(scene, camera, probe)
        } catch (e) {
          probe.reject(e)
        }
        return
      }
      throughEyeBuffer(scene, camera, scaleInForce())
    } finally {
      busy = false
    }
  }

  // ── the session boundary ────────────────────────────────────────────────
  const onSessionStart = (): void => {
    resetEyeScaleState(state)
    changes.length = 0
    frames = 0
    live = null
    lastFrame = null
  }
  const onSessionEnd = (): void => {
    xrTarget = null
    lastFrame = null
    live = null
    if (pendingProbe) {
      pendingProbe.reject(new Error('eye-buffer: the session ended before the probe ran'))
      pendingProbe = null
    }
  }
  xr.addEventListener('sessionstart', onSessionStart)
  xr.addEventListener('sessionend', onSessionEnd)

  const report = (): EyeBufferReport =>
    Object.freeze({
      requested: true as const,
      active: xr.isPresenting && xrTarget !== null,
      scale: scaleInForce(),
      pinned,
      msaa,
      glSamples,
      xrTargetSamples: xrTarget ? xrTarget.samples : null,
      layer: xrTarget ? { width: xrTarget.width, height: xrTarget.height } : null,
      live,
      frames,
      controllerFrames: state.frames,
      misses: state.missCount,
      ignored: state.ignored,
      backoff: state.backoff,
      changes: Object.freeze([...changes]),
      depthIgnored,
    })

  return {
    frame(periodSeconds, displayHz) {
      if (!xr.isPresenting || pinned !== null) return
      const change = stepEyeScale(state, periodSeconds, displayHz)
      if (!change) return
      changes.push(change)
      if (changes.length > CHANGES_KEPT) changes.shift()
      log(
        `eye-buffer: scale ${change.from} -> ${change.to} at frame ${change.frame} (${change.reason})`,
      )
    },
    pin(scale) {
      pinned = scale === null ? null : clampEyeScale(scale)
      log(`eye-buffer: scale ${pinned === null ? 'to the controller' : `pinned at ${pinned}`}`)
      return report()
    },
    report,
    probe(options = {}) {
      if (!xr.isPresenting) return Promise.reject(new Error('eye-buffer: not presenting'))
      if (pendingProbe) return Promise.reject(new Error('eye-buffer: a probe is already waiting'))
      return new Promise<EyeBufferProbe>((resolve, reject) => {
        pendingProbe = {
          scale: clampEyeScale(options.scale ?? 1),
          png: options.png === true,
          resolve,
          reject,
        }
      })
    },
    dispose() {
      renderer.render = render
      external.setRenderTargetTextures = setRenderTargetTextures
      external.setRenderTargetFramebuffer = setRenderTargetFramebuffer
      xr.removeEventListener('sessionstart', onSessionStart)
      xr.removeEventListener('sessionend', onSessionEnd)
      eyeTarget?.dispose()
      blitGeometry.dispose()
      blitMaterial.dispose()
    },
  }
}
