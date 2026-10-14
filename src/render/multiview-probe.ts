// src/render/multiview-probe.ts: one scene, both ways, in one JS turn. DEV-988.
//
// The pixel proof for `render/multiview.ts`. It draws the live stage twice,
// back to back, with nothing allowed to move between the two:
//
//   REFERENCE  three's own stereo path: an `ArrayCamera` of two eyes drawn into
//              one side-by-side target, each eye in its half, exactly as
//              `WebGLRenderer.render` draws a WebXR frame without multiview.
//   MULTIVIEW  the multiview path: the union camera, ONE pass, into a two-layer
//              texture array through `framebufferTextureMultiviewOVR`, with the
//              per-eye block written by the same `writeEyes` the XR frame calls.
//
// then reads each eye back and compares. Both targets are what a session draws
// into in the ways three's program key can see (`isXRRenderTarget`, the sRGB
// encode in the shader, no MSAA), so the reference compiles the session's own
// programs and the multiview arm the multiview programs a session would.
//
// What it cannot see: the XR layer itself (its acquisition, its swapchain, the
// compositor). The rig answers those, with `?multiview=1` in a real session
// (`docs/plan/eval-wave/eval-multiview.md`). Run in a session with `eyes:
// 'xr'` and the eyes are the headset's own (asymmetric frusta, the real IPD);
// flat, they are a synthetic pair around the app camera.
//
// Debug only: reached through `__ff2.multiviewProbe()` (`boot/app/debug-
// handle.ts`), never from the frame.

import * as THREE from 'three'
import type { Multiview } from './multiview'

export interface ProbeOptions {
  /** Each eye's size in pixels. Default 512 x 512. */
  readonly width?: number
  readonly height?: number
  /** `synthetic` (default): two eyes `ipd` apart around `camera`. `xr`: the session's own. */
  readonly eyes?: 'synthetic' | 'xr'
  /** Metres between the synthetic eyes. Default 0.064. */
  readonly ipd?: number
  /** Return each image as a PNG data URL as well (four of them). */
  readonly png?: boolean
}

export interface EyeComparison {
  readonly eye: 0 | 1
  /** Largest per-channel difference, 0 to 255. */
  readonly maxDiff: number
  /** Mean per-channel difference over RGB. */
  readonly meanDiff: number
  /** Pixels whose largest channel difference exceeds 2, and 8. */
  readonly over2: number
  readonly over8: number
  readonly pixels: number
}

export interface ProbeResult {
  readonly width: number
  readonly height: number
  readonly eyes: 'synthetic' | 'xr'
  /**
   * `renderer.info.render` of each arm's `render` call with the shadow maps
   * held (both arms read the maps one updating draw left), so each is the
   * arm's eye passes alone.
   */
  readonly reference: { readonly calls: number; readonly triangles: number }
  readonly multiview: { readonly calls: number; readonly triangles: number }
  readonly framebuffer: string
  /** GL errors read after each arm (0 = none). */
  readonly glError: { readonly reference: number; readonly multiview: number }
  readonly compare: readonly EyeComparison[]
  /**
   * The reference's left eye against its right: what a probe that drew the
   * same eye twice would score against `compare`. The eyes must differ by far
   * more than either arm differs from the other, or `compare` proves nothing.
   */
  readonly parallax: EyeComparison
  /** [reference left, reference right, multiview left, multiview right], when asked. */
  readonly png?: readonly string[]
}

const toPng = (rgba: Uint8Array, w: number, h: number): string => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const image = ctx.createImageData(w, h)
  // GL rows are bottom-up.
  for (let y = 0; y < h; y++) {
    image.data.set(rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Compare one eye. `a` is `aStride` pixels wide and the eye starts at column `aX`. */
const compareEye = (
  eye: 0 | 1,
  a: Uint8Array,
  aStride: number,
  aX: number,
  b: Uint8Array,
  w: number,
  h: number,
): EyeComparison => {
  let max = 0
  let sum = 0
  let over2 = 0
  let over8 = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * aStride + aX + x) * 4
      const j = (y * w + x) * 4
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((a[i + c] as number) - (b[j + c] as number))
        sum += d
        if (d > worst) worst = d
      }
      if (worst > max) max = worst
      if (worst > 2) over2++
      if (worst > 8) over8++
    }
  }
  return { eye, maxDiff: max, meanDiff: sum / (w * h * 3), over2, over8, pixels: w * h }
}

const _right = new THREE.Vector3()

/**
 * The cameras: a union camera to cull and sort with (the SAME one for both arms,
 * so both draw the same render list) and two eyes.
 */
const buildEyes = (
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  options: ProbeOptions,
): {
  union: THREE.ArrayCamera
  centre: THREE.PerspectiveCamera
  eyes: THREE.PerspectiveCamera[]
} => {
  const w = options.width ?? 512
  const h = options.height ?? 512
  const union = new THREE.ArrayCamera()
  const centre = new THREE.PerspectiveCamera()
  const eyes = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()]
  if (options.eyes === 'xr') {
    const xrCamera = renderer.xr.getCamera()
    const [l, r] = xrCamera.cameras
    if (!l || !r) throw new Error('multiview probe: no XR eyes (not presenting?)')
    for (const [i, src] of [l, r].entries()) {
      const e = eyes[i] as THREE.PerspectiveCamera
      e.matrixWorld.copy(src.matrixWorld)
      e.matrixWorldInverse.copy(src.matrixWorldInverse)
      e.projectionMatrix.copy(src.projectionMatrix)
      e.projectionMatrixInverse.copy(src.projectionMatrixInverse)
      e.layers.mask = src.layers.mask
    }
    for (const c of [union, centre]) {
      c.matrixWorld.copy(xrCamera.matrixWorld)
      c.matrixWorldInverse.copy(xrCamera.matrixWorldInverse)
      c.projectionMatrix.copy(xrCamera.projectionMatrix)
      c.projectionMatrixInverse.copy(xrCamera.projectionMatrixInverse)
      c.layers.mask = xrCamera.layers.mask
    }
  } else {
    camera.updateMatrixWorld()
    const ipd = options.ipd ?? 0.064
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
    const projection = new THREE.PerspectiveCamera(camera.fov, w / h, camera.near, camera.far)
    projection.updateProjectionMatrix()
    // Wide enough to hold both eyes for anything past the near plane's few
    // centimetres: three's own union is tighter; any superset culls the same.
    const wide = new THREE.PerspectiveCamera(
      Math.min(170, camera.fov + 20),
      w / h,
      camera.near,
      camera.far,
    )
    wide.updateProjectionMatrix()
    for (const [i, side] of [-0.5, 0.5].entries()) {
      const e = eyes[i] as THREE.PerspectiveCamera
      e.matrixWorld.copy(camera.matrixWorld)
      e.matrixWorld.elements[12] += _right.x * ipd * side
      e.matrixWorld.elements[13] += _right.y * ipd * side
      e.matrixWorld.elements[14] += _right.z * ipd * side
      e.matrixWorldInverse.copy(e.matrixWorld).invert()
      e.projectionMatrix.copy(projection.projectionMatrix)
      e.projectionMatrixInverse.copy(projection.projectionMatrixInverse)
      // three's eye masks: the app camera's, plus its own eye layer (1 left, 2 right).
      e.layers.mask = (camera.layers.mask | 0b110) & (i === 0 ? ~0b100 : ~0b010)
    }
    for (const c of [union, centre]) {
      c.matrixWorld.copy(camera.matrixWorld)
      c.matrixWorldInverse.copy(camera.matrixWorld).invert()
      c.projectionMatrix.copy(wide.projectionMatrix)
      c.projectionMatrixInverse.copy(wide.projectionMatrixInverse)
      c.layers.mask = camera.layers.mask | 0b110
    }
  }
  for (const [i, e] of eyes.entries()) {
    e.viewport = new THREE.Vector4(i * w, 0, w, h)
    e.matrixAutoUpdate = false
    e.matrixWorldAutoUpdate = false
  }
  for (const c of [union, centre]) {
    c.matrixAutoUpdate = false
    c.matrixWorldAutoUpdate = false
  }
  union.cameras = eyes
  return { union, centre, eyes }
}

/**
 * Draw `scene` both ways and compare the eyes. See the header. Leaves the
 * renderer's target, XR flag, clear and info settings as it found them.
 */
export const runMultiviewProbe = (
  renderer: THREE.WebGLRenderer,
  multiview: Multiview,
  scene: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  options: ProbeOptions = {},
): ProbeResult => {
  const gl = renderer.getContext() as WebGL2RenderingContext
  const w = options.width ?? 512
  const h = options.height ?? 512
  const { union, centre, eyes } = buildEyes(renderer, camera, options)

  // ── the reference target: side by side, RGBA8, encoded in the shader ────
  const reference = new THREE.WebGLRenderTarget(w * 2, h, {
    samples: 0,
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
  })
  reference.texture.internalFormat = 'RGBA8'
  ;(reference as { isXRRenderTarget?: boolean }).isXRRenderTarget = true

  // ── the multiview target: our own texture array, two layers ─────────────
  const color = gl.createTexture() as WebGLTexture
  const depth = gl.createTexture() as WebGLTexture
  renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, color)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, h, 2)
  renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, depth)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT24, w, h, 2)
  renderer.state.unbindTexture()
  const fb = gl.createFramebuffer() as WebGLFramebuffer
  const framebuffer = multiview.attach(fb, color, depth)
  const target = new THREE.WebGLRenderTarget(w, h, { samples: 0 })
  ;(target as { isXRRenderTarget?: boolean }).isXRRenderTarget = true
  multiview.useTarget(target, fb)

  const previousTarget = renderer.getRenderTarget()
  const previousXr = renderer.xr.enabled
  const previousReset = renderer.info.autoReset
  const previousShadows = renderer.shadowMap.autoUpdate
  const refPixels = new Uint8Array(w * 2 * h * 4)
  const mvPixels = [new Uint8Array(w * h * 4), new Uint8Array(w * h * 4)]
  let refDraws = { calls: 0, triangles: 0 }
  let mvDraws = { calls: 0, triangles: 0 }
  const glError = { reference: 0, multiview: 0 }
  try {
    renderer.xr.enabled = false
    renderer.info.autoReset = true
    gl.getError()

    // Once with the shadow maps updating, as a frame draws, and then again
    // with them held: from here on both arms read the SAME shadow maps, and
    // each arm's count is its eye passes alone, so the halving is a count.
    renderer.setRenderTarget(reference)
    renderer.render(scene, union)
    renderer.shadowMap.autoUpdate = false
    renderer.render(scene, union)
    refDraws = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
    glError.reference = gl.getError()
    renderer.readRenderTargetPixels(reference, 0, 0, w * 2, h, refPixels)

    renderer.setRenderTarget(target)
    multiview.writeEyes({
      centre,
      left: eyes[0] as THREE.Camera,
      right: eyes[1] as THREE.Camera,
    })
    renderer.render(scene, centre)
    mvDraws = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }
    glError.multiview = gl.getError()

    const readFb = gl.createFramebuffer()
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb)
    for (let i = 0; i < 2; i++) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, color, 0, i)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, mvPixels[i] as Uint8Array)
    }
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.deleteFramebuffer(readFb)
  } finally {
    renderer.setRenderTarget(previousTarget)
    renderer.xr.enabled = previousXr
    renderer.info.autoReset = previousReset
    renderer.shadowMap.autoUpdate = previousShadows
    reference.dispose()
    target.dispose()
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(color)
    gl.deleteTexture(depth)
  }

  const compare = [
    compareEye(0, refPixels, w * 2, 0, mvPixels[0] as Uint8Array, w, h),
    compareEye(1, refPixels, w * 2, w, mvPixels[1] as Uint8Array, w, h),
  ]
  const leftOfReference = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    leftOfReference.set(refPixels.subarray(y * w * 2 * 4, (y * w * 2 + w) * 4), y * w * 4)
  }
  const parallax = compareEye(1, refPixels, w * 2, w, leftOfReference, w, h)
  const result: ProbeResult = {
    width: w,
    height: h,
    eyes: options.eyes ?? 'synthetic',
    reference: refDraws,
    multiview: mvDraws,
    framebuffer,
    glError,
    compare,
    parallax,
  }
  if (!options.png) return result
  const half = (x0: number): Uint8Array => {
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      out.set(refPixels.subarray((y * w * 2 + x0) * 4, (y * w * 2 + x0 + w) * 4), y * w * 4)
    }
    return out
  }
  return {
    ...result,
    png: [
      toPng(half(0), w, h),
      toPng(half(w), w, h),
      toPng(mvPixels[0] as Uint8Array, w, h),
      toPng(mvPixels[1] as Uint8Array, w, h),
    ],
  }
}

/** One frame of the REAL eye buffer, both eyes. */
export interface XrEyeCapture {
  /** `array` under multiview (the layer's two layers), `side-by-side` without. */
  readonly layout: 'array' | 'side-by-side'
  /** One eye's size in pixels. */
  readonly width: number
  readonly height: number
  /** [left, right], PNG data URLs, each downsampled by `step` in both axes. */
  readonly png: readonly [string, string]
  readonly step: number
  /** `renderer.info.render.calls` of the frame that was read. */
  readonly calls: number
}

/**
 * Read the eye buffer of the NEXT XR frame, after three has drawn it and
 * before the frame ends (the layer's textures are valid only inside the frame,
 * so a read from a `page.evaluate` would see nothing). One shot: the stage's
 * `onAfterRender` is borrowed for one frame and handed back.
 *
 * `arrayTexture` is multiview's current colour texture (`Multiview.texture`),
 * or null without multiview, in which case three's own side-by-side target is
 * bound and is read as it is (it must be single-sampled: `?aa=0`).
 */
export const captureXrEyes = (
  renderer: THREE.WebGLRenderer,
  stage: THREE.Scene,
  arrayTexture: (() => WebGLTexture | null) | null,
  step = 2,
): Promise<XrEyeCapture> =>
  new Promise((resolve, reject) => {
    const gl = renderer.getContext() as WebGL2RenderingContext
    const previous = stage.onAfterRender
    stage.onAfterRender = (...args) => {
      stage.onAfterRender = previous
      previous.apply(stage, args)
      try {
        if (!renderer.xr.isPresenting) throw new Error('captureXrEyes: not presenting')
        const target = renderer.getRenderTarget()
        if (!target) throw new Error('captureXrEyes: no XR target bound')
        const texture = arrayTexture?.() ?? null
        const width = texture ? target.width : target.width / 2
        const height = target.height
        const eyes: Uint8Array[] = []
        const readFb = texture ? gl.createFramebuffer() : null
        if (readFb) renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, readFb)
        for (let i = 0; i < 2; i++) {
          const out = new Uint8Array(width * height * 4)
          if (texture) {
            gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, i)
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
          } else {
            gl.readPixels(i * width, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
          }
          eyes.push(out)
        }
        if (readFb) {
          renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
          gl.deleteFramebuffer(readFb)
        }
        const w = Math.floor(width / step)
        const h = Math.floor(height / step)
        const small = (eye: Uint8Array): Uint8Array => {
          const out = new Uint8Array(w * h * 4)
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const from = (y * step * width + x * step) * 4
              out.set(eye.subarray(from, from + 4), (y * w + x) * 4)
            }
          }
          return out
        }
        resolve({
          layout: texture ? 'array' : 'side-by-side',
          width,
          height,
          step,
          calls: renderer.info.render.calls,
          png: [
            toPng(small(eyes[0] as Uint8Array), w, h),
            toPng(small(eyes[1] as Uint8Array), w, h),
          ],
        })
      } catch (e) {
        reject(e)
      }
    }
  })
