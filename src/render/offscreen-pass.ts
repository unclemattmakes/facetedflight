import * as THREE from 'three'

/**
 * What an off-screen pass borrows from the renderer (code-reuse RC-6 and XC-18).
 *
 * Three passes draw the world into a render target of their own: the near
 * shadow, the cockpit's self-shadow, and the sea's mirror. Each has to borrow
 * the renderer, point it at a target, run one `render`, and hand EVERYTHING
 * back, and each has to say what the pass drew. They wrote that out three
 * times, so this is the one copy, and what differs between them (the mirror
 * clears colour as well as depth) is an option rather than a fork.
 *
 * The renderer is described by the members used and not by `WebGLRenderer`, so
 * a unit test can stand in a stub that records the order of calls.
 */
export interface OffscreenRenderer {
  render(scene: THREE.Object3D, camera: THREE.Camera): void
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void
  getRenderTarget(): THREE.WebGLRenderTarget | null
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void
  autoClear: boolean
  readonly xr: { enabled: boolean }
  readonly shadowMap: { autoUpdate: boolean }
  readonly state: { buffers: { depth: { setMask(mask: boolean): void } } }
  readonly info: { autoReset: boolean; render: { calls: number; triangles: number } }
}

/** A renderer that can also clear COLOUR to a chosen value and give the old one back. */
export interface OffscreenColourRenderer extends OffscreenRenderer {
  getClearColor(target: THREE.Color): THREE.Color
  getClearAlpha(): number
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void
}

/** Clear COLOUR too, to this colour, and restore the renderer's own clear colour after. */
export interface OffscreenClear {
  readonly hex: number
  readonly alpha: number
}

const _previousClear = new THREE.Color()

/**
 * Borrow the renderer, point it at `target`, clear it, run `draw`, and hand
 * EVERYTHING back, in a `finally`, because a throw on a lost context that left
 * `xr.enabled` false would put the next headset frame through a flat camera.
 *
 * `xr.enabled` off because three swaps the view camera for the XR one in any
 * `render()` while presenting (three's own `Reflector` does exactly this, in
 * this order). The depth mask forced on because the last draw may have been a
 * colourless one (DEV-305), which leaves it off, and a clear with the mask off
 * clears nothing. `autoUpdate` off so the pass can never re-render the SUN's
 * map; `autoReset` off so `info` counts this pass as a difference.
 *
 * Without `clear` only depth is cleared. With it, colour is cleared too, to
 * `clear.hex` at `clear.alpha`, and the renderer's own clear colour and alpha
 * are read first and put back.
 *
 * What a pass keeps beyond this (the mirror's `scene.background`, its camera
 * move, its masking) belongs in the caller's own `try/finally` around this
 * call, so nothing is skipped on a throw.
 */
export function withOffscreenTarget(
  renderer: OffscreenRenderer,
  target: THREE.WebGLRenderTarget,
  draw: () => void,
): void
export function withOffscreenTarget(
  renderer: OffscreenColourRenderer,
  target: THREE.WebGLRenderTarget,
  draw: () => void,
  clear: OffscreenClear,
): void
export function withOffscreenTarget(
  renderer: OffscreenRenderer | OffscreenColourRenderer,
  target: THREE.WebGLRenderTarget,
  draw: () => void,
  clear?: OffscreenClear,
): void {
  const previousTarget = renderer.getRenderTarget()
  const previousXr = renderer.xr.enabled
  const previousAutoClear = renderer.autoClear
  const previousAutoUpdate = renderer.shadowMap.autoUpdate
  const previousAutoReset = renderer.info.autoReset
  const colourRenderer = clear ? (renderer as OffscreenColourRenderer) : null
  let previousAlpha = 0
  if (colourRenderer) {
    colourRenderer.getClearColor(_previousClear)
    previousAlpha = colourRenderer.getClearAlpha()
  }
  try {
    renderer.xr.enabled = false
    renderer.shadowMap.autoUpdate = false
    renderer.autoClear = false
    renderer.info.autoReset = false
    renderer.setRenderTarget(target)
    if (colourRenderer && clear) colourRenderer.setClearColor(clear.hex, clear.alpha)
    renderer.state.buffers.depth.setMask(true)
    renderer.clear(clear !== undefined, true, false)
    draw()
  } finally {
    if (colourRenderer) colourRenderer.setClearColor(_previousClear, previousAlpha)
    renderer.xr.enabled = previousXr
    renderer.setRenderTarget(previousTarget)
    renderer.autoClear = previousAutoClear
    renderer.shadowMap.autoUpdate = previousAutoUpdate
    renderer.info.autoReset = previousAutoReset
  }
}

/** What one {@link measuredRender} drew, off `renderer.info`. */
export interface PassDraws {
  calls: number
  triangles: number
}

const _draws: PassDraws = { calls: 0, triangles: 0 }

/**
 * `renderer.render(scene, camera)`, and what it drew: the difference in
 * `renderer.info.render` across the call. Meaningful only under
 * {@link withOffscreenTarget}, which switches `info.autoReset` off so the
 * counters run on across this pass.
 *
 * The result is ONE shared object, overwritten by the next call: read it
 * before anything else renders. (It is per frame per pass, so a fresh object
 * each time would be a small garbage stream in a headset.)
 */
export const measuredRender = (
  renderer: OffscreenRenderer,
  scene: THREE.Object3D,
  camera: THREE.Camera,
): Readonly<PassDraws> => {
  const calls0 = renderer.info.render.calls
  const triangles0 = renderer.info.render.triangles
  renderer.render(scene, camera)
  _draws.calls = renderer.info.render.calls - calls0
  _draws.triangles = renderer.info.render.triangles - triangles0
  return _draws
}

/**
 * Three's own PCF shadow target, transcribed (`WebGLShadowMap.render`): a depth
 * texture with a compare function and linear filters, which is what makes
 * `sampler2DShadow` a hardware 2x2 compare per tap. `name` is the depth
 * texture's, for the receipts.
 */
export const createPcfDepthTarget = (size: number, name: string): THREE.WebGLRenderTarget => {
  const target = new THREE.WebGLRenderTarget(size, size)
  target.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType)
  target.depthTexture.format = THREE.DepthFormat
  target.depthTexture.compareFunction = THREE.LessEqualCompare
  target.depthTexture.minFilter = THREE.LinearFilter
  target.depthTexture.magFilter = THREE.LinearFilter
  target.depthTexture.name = name
  return target
}
