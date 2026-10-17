// src/render/renderer.ts — the one renderer and the one camera.
//
// `WebGLRenderer`, NOT `WebGPURenderer`. This is not a preference: WebXR
// support lives on `renderer.xr`, and the WebGPU path does not have it
// (PORT_PLAN §2.1 / DECISIONS D2). king-tide is on WebGPU; do not copy that
// choice across.

import * as THREE from 'three'
import { type ComfortSettings, DEFAULT_SETTINGS } from '@/boot/settings'
import { attachCanvasFit, type FitWindow } from '@/render/canvas-fit'
import { type EyeBuffer, type EyeBufferOptions, installEyeBuffer } from '@/render/eye-buffer'
import { useEyeConsistentDither } from '@/render/eye-dither'
import {
  createQualityController,
  msaaFor,
  type QualityController,
  type QualityOptions,
} from '@/render/quality'

/**
 * The reference space this session asks for.
 *
 * Named rather than inlined so a probe can assert against **the value the
 * renderer uses** instead of against a copy of it. DEV-069 is the cautionary
 * case in the other direction: `hoverjet.input.controlScheme` read `a` with
 * `trust: verified` for four sessions while `gamepad.ts` shipped a layout that
 * was not scheme a, because nothing in the code ever read the key.
 */
export const XR_REFERENCE_SPACE: XRReferenceSpaceType = 'local'

/** DECISIONS D18: one camera, near 0.08 / far 6000. */
export const CAMERA_NEAR = 0.08
export const CAMERA_FAR = 6000

/**
 * near 0.08 is a comfort decision, not an arbitrary default. The 2016 game put
 * the player inside a big enclosed cockpit at a 0.06 m near plane, and that
 * occlusion is one of the five things doing the comfort work (PORT_PLAN §2.9).
 * Raising it clips the cockpit interior in-headset; "does the cockpit interior
 * clip" is a question for a worn check for exactly this reason.
 */
export interface Renderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  /** XR rig. In session, the headset pose is applied under this — move the rig, never the camera. */
  readonly rig: THREE.Group
  /**
   * Quality presets, foveation and adaptive resolution (PORT_PLAN M2, §2.9).
   *
   * Handed out rather than hidden because two of its three knobs are only legal
   * at particular moments — read the header of `render/quality.ts` before
   * calling it. `apply()` on a settings change, `frame()` once a frame,
   * `applyBeforeSession()` before `requestSession`.
   */
  readonly quality: QualityController
  /**
   * DEV-994: the app-owned eye buffer, or null without `?eyeBuffer=1`. In a
   * session it draws the eyes at a scale that can move every frame and
   * upsamples them into three's XR target (`render/eye-buffer.ts`).
   */
  readonly eyeBuffer: EyeBuffer | null
  dispose(): void
}

export const createRenderer = (
  canvas: HTMLCanvasElement,
  /**
   * The player's stored comfort settings. Defaulted so every existing call site
   * and every test keeps working, and so a renderer built before the settings
   * have loaded is not a different renderer — `DEFAULT_SETTINGS.quality` is
   * `high`, whose pixel-ratio cap of 2 is exactly what this file did before the
   * preset existed.
   */
  settings: ComfortSettings = DEFAULT_SETTINGS,
  /**
   * Passed straight to the quality controller. The only caller that supplies
   * one is `boot/app.ts`, handing it `() => perf.modalHz()` so the frame budget
   * can be MEASURED where the runtime does not report a rate (VR-PERF §5.3).
   *
   * Optional and defaulted for the same reason `settings` is: every existing
   * call site and every test keeps working, and a renderer built without it is
   * not a different renderer — it simply falls back to `DEFAULT_TARGET_HZ_XR`
   * the way it always did, and says so in `report.targetSource`.
   */
  qualityOptions: QualityOptions = {},
  /**
   * `?aa=0|1`, DEV-165. Null (the default) means the tier decides.
   *
   * A parameter rather than a read of `location` because this file has no
   * business knowing about the URL — `boot/app.ts` parses every other pin and
   * hands it down, and a renderer built in a test must not depend on a query
   * string that is not there.
   */
  msaaPin: boolean | null = null,
  /**
   * DEV-994: `?eyeBuffer=1`'s options, or null (the default) for none. Null
   * installs nothing and the renderer is today's, byte for byte.
   */
  eyeBufferOptions: EyeBufferOptions | null = null,
): Renderer => {
  // ── `antialias` is the QUALITY TIER's now, not a constant (DEV-165) ──────
  //
  // It used to be `true`, unconditionally, decided when the only surface was a
  // 1280 x 720 canvas. three turns it into `samples: 4` on the XR projection
  // layer, so on the Steam Frame that one boolean is a 5032 x 2516 four-sample
  // colour target and a four-sample depth buffer, resolved every frame.
  //
  // It is a CONTEXT ATTRIBUTE: fixed for the life of this context, so a tier
  // change lands on the next load. `render/quality.ts`'s `msaaFor` is the one
  // place the decision is made, and `?aa=` is how a measurement pair is taken
  // — two loads, because there is no way to flip it on a live context.
  const antialias = msaaFor(settings.quality, msaaPin)
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias,
    powerPreference: 'high-performance',
  })
  // DEV-556: the PCF penumbra and the LOD screen-door seed their noise from
  // the EYE's pixel, so both eyes draw one picture. Before anything compiles,
  // which nothing can do without this renderer. `render/eye-dither.ts`.
  useEyeConsistentDither(renderer)
  renderer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false)
  renderer.xr.enabled = true
  // ── `local`, NOT three's default `local-floor` ──────────────────────────
  //
  // `local-floor` puts the origin on the physical floor, so the headset pose
  // arrives 1.2 m (seated) to 1.7 m (standing) above it. The rig sits at the
  // ship's eye point, and the camera is a child of the rig — so a floor-relative
  // space would put your actual head that far ABOVE the pilot's eyes, i.e.
  // through the canopy roof, in a cockpit you cannot get out of.
  //
  // `local` puts the origin at the viewer's head where the session begins, which
  // is what a seated cockpit wants: sit however you like, and the ship's eye
  // point is where your eyes are.
  //
  // It stays in `optionalFeatures` (`xr-support.ts`) because that list is about
  // what the runtime may offer, not about which space we ask for.
  //
  // NOT VERIFIED IN A HEADSET YET. It is one line either way and it is the first
  // thing to check in the next worn pass.
  renderer.xr.setReferenceSpaceType(XR_REFERENCE_SPACE)

  const scene = new THREE.Scene()
  // The mission world's stage. `boot/app.ts` names the menu world's `menu` and
  // `App.stage()` returns whichever is live — so "which stage is on screen" has
  // an answer from outside the page, which is what the fade needed (DEV-107).
  scene.name = 'mission'

  const camera = new THREE.PerspectiveCamera(
    70,
    (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
    CAMERA_NEAR,
    CAMERA_FAR,
  )

  const rig = new THREE.Group()
  rig.name = 'xr-rig'
  rig.add(camera)
  scene.add(rig)

  // ── quality, foveation, adaptive resolution ─────────────────────────────
  //
  // AFTER `xr.enabled`, and before any session: `setFramebufferScaleFactor` is
  // read when three builds the XR layer and is refused once presenting, so the
  // only moment it can be set is now (three.module.js:14144). This call is also
  // what sets the pixel ratio the constructor used to set inline — the cap is
  // the preset's, and at `high` it is the same 2.
  const quality = createQualityController(renderer, qualityOptions)
  quality.apply(settings)
  // DEV-994: before any session, so its hooks see three's XR target from the
  // session's first frame. Absent the pin, nothing is wrapped.
  const eyeBuffer = eyeBufferOptions ? installEyeBuffer(renderer, eyeBufferOptions) : null

  // ── the canvas's box, followed (DEV-595) ────────────────────────────────
  //
  // Not just the window's `resize`: a phone can send that event while its
  // layout still has the pre-turn shape, and a handler that reads the box once
  // inside it keeps the old aspect with nothing to ask again (Matt, on his
  // phone: *"camera aspect is squished after rotating"*). `render/canvas-fit.ts`
  // asks whenever the box can have moved, including from a `ResizeObserver`
  // that runs after layout, and applies only when the size differs.
  //
  // In session the HEADSET owns the drawing buffer, and three refuses the call
  // with `THREE.WebGLRenderer: Can't change size while VR device is
  // presenting.` Entering VR on a Quest fires a burst of resize events as the
  // 2D page is torn down, so without the skip the first seconds of every
  // session emit ~80 identical warnings, enough to bury a real one, which is
  // exactly what happened the first time this was worn.
  //
  // The projection matrix is the headset's too: `renderer.xr` overwrites the
  // camera's per-eye matrices every frame, so touching `aspect` here would
  // either be ignored or fight it.
  const canvasFit = attachCanvasFit(
    canvas,
    (globalThis.window ?? null) as unknown as FitWindow | null,
    (w, h) => {
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    },
    { skip: () => renderer.xr.isPresenting },
  )
  // Leaving a session, three puts back the size from BEFORE it
  // (`WebXRManager` onSessionEnd, then `sessionend`), and a turn or a window
  // resize made while presenting was skipped above. Ask once, unconditionally.
  const onSessionEnd = () => {
    canvasFit.refit(true)
  }
  renderer.xr.addEventListener('sessionend', onSessionEnd)

  return {
    renderer,
    scene,
    camera,
    rig,
    quality,
    eyeBuffer,
    dispose() {
      eyeBuffer?.dispose()
      canvasFit.dispose()
      renderer.xr.removeEventListener('sessionend', onSessionEnd)
      // The quality controller listens on `renderer.xr` for both ends of a
      // session (DEV-178); `renderer.dispose()` does not clear those.
      quality.dispose()
      renderer.setAnimationLoop(null)
      renderer.dispose()
    },
  }
}
