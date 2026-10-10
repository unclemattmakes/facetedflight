// src/render/bloom.ts — bloom, on the flat build, from 2016's own numbers.
//
// ANNIVERSARY.md §3.2 V2, PORT_PLAN §6.1's cut, DEV-091.
//
// ── What 2016 had, traced rather than assumed ─────────────────────────────
//
// `BloomOptimized` (Unity Standard Assets, guid `4975a6e437fc3b149a8cd508ce5
// bdd69`) with **threshold 0.63, intensity 0.53, blurSize 1.2, blurIterations 1,
// blurType 0** — the same five numbers in every instance in the project. Three of
// those instances matter:
//
//  * `Prefabs/Cameras_gameplay.prefab`, `MonoBehaviour &11423924`, `m_Enabled: 1`,
//    on GameObject `&106732` — **`Main Camera`**, tag `MainCamera`, `m_IsActive: 1`
//    — whose Transform's `m_Father` is `&498066`, the Transform of `&116488`
//    **`Mono_Cam`**, and `Mono_Cam` is **`m_IsActive: 0`**.
//  * `Resources/JumpSeat_Photon.prefab`, twice, on `VR_Cam` and `Main Camera`
//    under `Cameras (1)` — and all three of those GameObjects are `m_IsActive: 0`.
//
// So the liveness walk CLAUDE.md's rule 2 and DEV-051 ask for says the component
// is not live as authored, and the thing that decides whether it ever ran is
// `Scripts/CameraMode.cs`:
//
//     public GameObject camera_mono;   // = &116488, Mono_Cam
//     public GameObject camera_vr;     // = &1000010415690808, the OVR rig
//     private static bool vrMode = true;
//     void Start() { camera_vr.SetActive(vrMode); camera_mono.SetActive(!vrMode); }
//     void Update() { if (Input.GetKeyDown(KeyCode.V)) ToggleCameras(); }
//
// `vrMode` is `private` with no `[SerializeField]`, so it is a **code default**
// and hard rule 2 lets it ship: the game boots with the VR rig on and the mono
// camera off. The active VR camera in that prefab (`CenterEyeAnchor`) carries no
// image effect at all.
//
// **Therefore 2016's bloom was the FLAT camera's, default off, one V away — and
// the headset never saw it.** `int_01_hoverJet.unity` contains no
// `BloomOptimized` block of its own and no `m_Modifications` re-activating
// `Mono_Cam`; `PlayerShip_SR14_Photon.prefab`, the ship all seven HoverJet
// missions instantiate, has none either. PORT_PLAN §6.1's *"every shipped mission
// ran it"* is true of *carried* and not of *ran*: that was a structural claim with
// one source (§4.7), and this is the walk.
//
// That makes "flat build only" the FAITHFUL choice here rather than a budget
// compromise, which is a happier place to be than V2 expected to be in.
//
// Standard Assets may not cross (hard rule 7 / D26): nothing here is translated
// from `BloomOptimized.cs` or its shader. The five numbers are read as observed
// behaviour and reimplemented with three's own `UnrealBloomPass`, which is part
// of three and fine.
//
// ── The threshold's domain, and why 0.63 carries over unchanged ───────────
//
// Unity 5's forward path in a Linear project writes linear radiance to an LDR
// framebuffer where 1.0 is clipping white, and the image effect ran on THAT —
// there was no tone curve (`render/tone.ts`). So `threshold: 0.63` is *"63 % of
// the way to clipping white, in linear light."*
//
// Inside an `EffectComposer` the same quantity is what the target holds, because
// three applies `renderer.toneMapping` **only when the destination is the canvas
// or an XR target** (`three.module.js:7551` and `:18345`, both
// `if (_currentRenderTarget === null || _currentRenderTarget.isXRRenderTarget)`).
// Nothing in the scene is tone-mapped on the way into the buffer, `OutputPass`
// applies the curve and the sRGB transfer at the end, and the buffer is
// `HalfFloatType` — so 3.0 stays 3.0 instead of clamping at 1.0, which is the
// headroom DEV-081 bought. three's high pass thresholds Rec.709 luminance with
// `smoothWidth` 0.01, i.e. a hard edge like 2016's.
//
// **0.63 therefore transfers as a number and not as a feeling.** The one thing
// that changed is how much energy is ABOVE it: 2016's buffer clipped at 1.0 and
// ours does not, so the same threshold now passes more. That is why `strength` is
// not 2016's `intensity` — see `content/editions/anniversary.json`, which carries
// the arithmetic per key, and why the shipped `threshold` is not 0.63 either.
//
// **`attachEditionTone` is still the only owner of the curve.** `OutputPass`
// does not hold a copy: it reads `renderer.toneMapping` and
// `renderer.toneMappingExposure` on every `render()` and rebuilds its own defines
// when either moves (`OutputPass.js:93` and `:97-114`). So `render/tone.ts` writes
// two renderer properties, a preset flip still costs no recompile of anything in
// the scene, and the `?lookdev=1` exposure slider still moves live — with the
// curve applied once, at the end, instead of per material.
//
// ── Why the UI is exempt, and why the exemption cannot be a material flag ──
//
// `render/tone.ts` draws the line: *a surface showing a canvas-drawn UI texture,
// or one that exists to modify the frame rather than to be in the world, is not
// tone-mapped.* The same line decides what is not bloomed — a white-on-dark HUD
// is 2016's unlit UI geometry, not a light in the world, and a glow crawling off
// its digits would be the instrument lying about the frame.
//
// `material.toneMapped = false` cannot carry that exemption here, because the
// three line quoted above means NO material is tone-mapped inside the composer:
// the flag stops meaning anything the moment a render target is involved, and
// `OutputPass` would put ACES on the HUD along with everything else. So the split
// has to be spatial, in two passes:
//
//  1. the **world** pass — the scene minus the UI layer — through the composer:
//     `RenderPass` → `UnrealBloomPass` → `OutputPass`, tone-mapped and encoded
//     once, at the end, to the canvas;
//  2. the **UI** pass — the UI layer only — `renderer.render` straight to the
//     canvas with `autoClear` off and the depth buffer cleared, which is the path
//     Classic has always taken and is where `toneMapped: false` means what it
//     says again.
//
// The depth clear is the one deliberate difference: UI-against-UI depth survives,
// UI-against-world does not, so the UI is unconditionally in front. Every surface
// on the line is already in front of the eye or already `depthTest: false`
// (`briefing.ts`, `results.ts`, `pause.ts`, `hud.ts`, `title.ts`'s wordmark and
// prompt, `hangar.ts`'s labels, `vignette.ts`, `horizon.ts`), and the A/B frames
// and `walkthrough.spec.ts` are what check it rather than this comment.
//
// Two consequences worth knowing before adding a UI surface:
//
//  * **A LIT material must never be on the line.** The UI pass gathers no lights
//    (the camera's mask is the UI layer alone and every light is on layer 0), so a
//    `MeshStandardMaterial` with `toneMapped: false` would render black. Every
//    surface on the line today is `MeshBasicMaterial` or an unlit
//    `ShaderMaterial`, which is what the line means by "a canvas somebody drew".
//  * **The camera keeps the UI layer enabled for ever.** Classification moves an
//    object ONTO the UI layer and nothing moves it back, so a flip to Classic
//    must still draw it — `render()` enables the layer on the camera on every
//    frame, on both presets, before it decides anything else.
//
// ── Never in VR ──────────────────────────────────────────────────────────
//
// A post pass under `renderer.xr` means an off-screen target per eye and the loss
// of the compositor's direct path, on the platform M3 is fighting for 72 Hz
// (PORT_PLAN §6.1, R6's *"no post-processing pass"*). `render()` answers `false`
// whenever `renderer.xr.isPresenting` is true and `boot/app.ts` then takes the
// direct `renderer.render` it always took — and, as the archaeology above says,
// that is also what 2016 did. The VR variant V2 offers as the alternative — a
// faked halo on studs and the sun disc — is NOT built here: it is
// `render/vr-halo.ts` (DEV-336), drawn by `boot/app.ts` exactly while this
// refuses, so a headset gets halos and a monitor gets this pass.

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { EditionBloom } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'

/**
 * The layer the UI is drawn on when bloom is running.
 *
 * **3, and it may never again be 1 or 2, because those two belong to WebXR.**
 * `WebXRManager` (three.module.js:14618, and the comment there says it in
 * words — *"enable eye layers (1 = left, 2 = right)"*) derives the two eye
 * cameras from the app camera's mask:
 *
 *     cameraXR.layers.mask = camera.layers.mask | 0b110
 *     cameraL.layers.mask  = cameraXR.layers.mask & -5   // ~bit 2: KEEPS layer 1
 *     cameraR.layers.mask  = cameraXR.layers.mask & -3   // ~bit 1: DROPS layer 1
 *
 * So layer 1 is not *a* layer, it is **the left eye**. This shipped as 1, and
 * Matt found it in a headset on the first playthrough: *"UI only draws in one
 * eye"* (DEV-141). Bloom is off in VR, but `classify()` has already run for
 * every flat frame before the session started and `layers.set` is one-way —
 * *"Nothing puts it back, and nothing needs to"*, which was true of everything
 * except an eye. Every masks-and-bits argument below is about bit 3 now.
 *
 * Anything ≥ 3 survives both eye masks (they clear bits 1 and 2 and nothing
 * else), which is also why `boot/app.ts`'s `LOGO_LAYER` — 23, 2016's
 * `SpecialLighting`, which the title screen's key light is masked to and which
 * the camera therefore also enables (DEV-043) — was never part of this bug.
 * 3 rather than 24: it is the first free one, and the number carries no
 * meaning beyond *"not 0, not an eye"*.
 */
export const UI_LAYER = 3

/**
 * MSAA samples on the composer's colour target.
 *
 * The canvas is `antialias: true` (`render/renderer.ts`), and a faceted world is
 * *all* silhouette — every triangle edge is the art. Rendering the world into a
 * plain render target would throw that away and the Anniversary frame would
 * simply look worse than Classic, which is not a trade anybody offered. 4 is the
 * canvas's own likely count and the point where the returns flatten.
 */
export const BLOOM_SAMPLES = 4

/**
 * The user agents on which three DISCARDS a multisampled target's colour after
 * resolving it. Copied from `three.module.js` (`supportsInvalidateFramebuffer`),
 * and `tests/unit/bloom-samples.test.ts` reads three's build to hold the two
 * patterns equal, so a three upgrade that changes its sniff fails there.
 */
export const THREE_INVALIDATES_MSAA = /OculusBrowser/

/**
 * MSAA samples for the composer's target, on this user agent. DEV-330.
 *
 * On an `OculusBrowser` UA, three calls `invalidateFramebuffer` on the
 * multisampled colour right after every resolve, a tile-memory saving for
 * Quest. `UnrealBloomPass` then composites the glow BACK INTO that target, onto
 * contents three has just thrown away. What survives is the glow alone: a flat
 * Anniversary frame that is black but for the bloom and the HUD. It was found
 * under IWER, whose emulated Quest 3 carries that UA, and it is also what a
 * visitor opening the site in a Quest's 2D browser would have seen. The
 * composer never runs in a session (`willComposite`), so no headset frame is
 * affected. Losing MSAA on that one browser is the price; a black frame was the
 * alternative.
 */
export const bloomSamplesFor = (userAgent: string): number =>
  THREE_INVALIDATES_MSAA.test(userAgent) ? 0 : BLOOM_SAMPLES

/**
 * Is this object a UI surface — one the tone curve and the bloom both skip?
 *
 * The test is the FLAG, on the material, at its construction site (`render/
 * tone.ts` says why it lives there and not in a registry). One material with
 * `toneMapped === false` is enough: a multi-material mesh that mixes UI and world
 * would be a mesh that cannot answer the question, and there is none.
 */
export const isUiObject = (object: THREE.Object3D): boolean => {
  const material = (object as THREE.Mesh).material
  if (!material) return false
  if (Array.isArray(material)) return material.some((m) => m.toneMapped === false)
  return material.toneMapped === false
}

/** What the panel, the specs and the tests may ask about the live pass. */
export interface BloomReport {
  /** Has a composer been built? False for the life of a Classic session. */
  readonly built: boolean
  /** Drawing-buffer size the composer is currently sized for, in device pixels. */
  readonly width: number
  readonly height: number
  /** `composer.setSize` calls so far — a resize the adaptive controller caused. */
  readonly resizes: number
  /** Objects moved onto `UI_LAYER`, cumulative. */
  readonly uiObjects: number
}

export interface Bloom {
  /**
   * Draw one frame of `stage`.
   *
   * Returns **true** when the composite path ran and the caller must not render
   * again, and **false** — in VR, on Classic, and before the first size is
   * known — when the caller should take its own direct `renderer.render`.
   */
  render(stage: THREE.Scene, camera: THREE.Camera): boolean
  /**
   * Whether the NEXT `render` would take the composite path — the same test it
   * runs first, answered without drawing.
   *
   * For `render/warm-up.ts` (DEV-117): three keys a program on the render
   * target bound when it compiles, and the composer draws the scene into a
   * linear target, so a warm-up that compiled against the canvas would build
   * every program twice and the frame would still stall on the second.
   */
  willComposite(): boolean
  /**
   * Re-read the tuning. Three pass properties and a target size: no material in
   * the scene is touched and nothing recompiles (`UnrealBloomPass` reads
   * `threshold`, `strength` and `radius` into uniforms on every render).
   */
  setBloom(block: EditionBloom): void
  readonly report: BloomReport
  dispose(): void
}

/**
 * What this module touches on the renderer.
 *
 * Narrow on purpose, the way `render/shadows.ts`'s `ShadowRenderer` is: the two
 * paths that MUST be provable — skipped in VR, never built on Classic — are then
 * testable with a plain object and no GL context at all, which is the only way
 * "never in VR" gets an assertion rather than a comment.
 */
export interface BloomRenderer
  extends Pick<
    THREE.WebGLRenderer,
    'autoClear' | 'clearDepth' | 'render' | 'getDrawingBufferSize'
  > {
  readonly xr: Pick<THREE.WebGLRenderer['xr'], 'isPresenting'>
  readonly info: Pick<THREE.WebGLRenderer['info'], 'autoReset' | 'reset'>
}

/** Volatile. The drawing-buffer size, re-read every frame. */
const _drawSize = new THREE.Vector2()

export const createBloom = (renderer: BloomRenderer, editionState: EditionState): Bloom => {
  let composer: EffectComposer | null = null
  let renderPass: RenderPass | null = null
  let bloomPass: UnrealBloomPass | null = null
  let outputPass: OutputPass | null = null
  let target: THREE.WebGLRenderTarget | null = null

  let width = 0
  let height = 0
  let resizes = 0
  /** The scale the passes were last sized at, so a lookdev change re-sizes. */
  let sizedScale = 0

  /**
   * Everything classified so far, UI or not.
   *
   * A `WeakSet` rather than a flag on the object: the scene graph is not ours to
   * write to, a disposed chunk should not be kept alive by a bookkeeping entry,
   * and the traverse below then costs one hash lookup per object rather than a
   * material read.
   */
  const classified = new WeakSet<THREE.Object3D>()
  let uiObjects = 0

  const dropComposer = (): void => {
    bloomPass?.dispose()
    outputPass?.dispose()
    composer?.dispose()
    // `composer.dispose()` disposes renderTarget1 and renderTarget2 — and
    // renderTarget1 IS the target handed to the constructor, so disposing it
    // again here would be a double free. `RenderPass` holds no GPU resource.
    composer = null
    renderPass = null
    bloomPass = null
    outputPass = null
    target = null
    width = 0
    height = 0
    sizedScale = 0
  }

  /**
   * Put the live numbers on the passes.
   *
   * `threshold`, `strength` and `radius` are plain properties `UnrealBloomPass`
   * copies into uniforms inside its own `render` (`UnrealBloomPass.js:309`,
   * `:343-344`), so a flip or a slider is live with nothing rebuilt.
   * `resolutionScale` is the exception — it is a texture size — so it goes
   * through the resize path.
   */
  const applyTuning = (block: EditionBloom): void => {
    if (!bloomPass) return
    bloomPass.threshold = block.threshold
    bloomPass.strength = block.strength
    bloomPass.radius = block.radius
    if (block.resolutionScale !== sizedScale) resize(block, true)
  }

  /**
   * Follow the DRAWING BUFFER, not the canvas.
   *
   * `render/quality.ts` moves the pixel ratio live on the flat build — adaptive
   * resolution steps it down through `ADAPTIVE_STEPS` when the frame budget runs
   * out — and `renderer.setSize` moves the CSS size on a window resize. Both end
   * up in `getDrawingBufferSize`, which is the one number that is true of the
   * pixels actually being drawn. A bloom left at a stale size is not an error and
   * nothing logs it: it is a blurry frame, or a sharp one with a soft glow that
   * does not line up.
   *
   * `composer.setPixelRatio(1)` is set at construction so the composer's own
   * `_pixelRatio` never double-counts what is already in this number.
   */
  const resize = (block: EditionBloom, force = false): void => {
    if (!composer || !bloomPass) return
    renderer.getDrawingBufferSize(_drawSize)
    const w = Math.max(1, Math.round(_drawSize.x))
    const h = Math.max(1, Math.round(_drawSize.y))
    if (!force && w === width && h === height) return
    width = w
    height = h
    sizedScale = block.resolutionScale
    resizes += 1
    composer.setSize(w, h)
    // AFTER the composer, which sizes every pass to the FULL buffer. The bloom's
    // own chain is the one thing that is allowed to be smaller, and `setSize`
    // ignores `this.resolution` and halves whatever it is given
    // (`UnrealBloomPass.js:250-262`) — so the five mips start at
    // `w * scale / 2`, and `resolutionScale: 1` is already §3.2's half-res bloom.
    const scale = block.resolutionScale
    bloomPass.setSize(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)))
  }

  const build = (block: EditionBloom): void => {
    // A target of our own rather than the composer's default, for `samples`:
    // three's default is `HalfFloatType` already (`EffectComposer.js:69`) but
    // plain, and a faceted world without MSAA is a different game.
    renderer.getDrawingBufferSize(_drawSize)
    target = new THREE.WebGLRenderTarget(
      Math.max(1, Math.round(_drawSize.x)),
      Math.max(1, Math.round(_drawSize.y)),
      {
        type: THREE.HalfFloatType,
        samples: bloomSamplesFor(globalThis.navigator?.userAgent ?? ''),
      },
    )
    target.texture.name = 'bloom.scene'
    // The composer needs the whole renderer; `BloomRenderer` names what the two
    // paths that skip it touch, which is what makes those two testable.
    composer = new EffectComposer(renderer as unknown as THREE.WebGLRenderer, target)
    composer.setPixelRatio(1)
    // The scene is rewritten on every frame — `boot/app.ts` swaps the stage
    // between the mission world and the menu world (DEV-076) — so the one handed
    // in here is a placeholder and `render()` owns it.
    renderPass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera())
    // `resolution` is only the constructor's seed; `resize` below is what sizes
    // the mips, and it is called before the first frame is composited.
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width || 2, height || 2),
      block.strength,
      block.radius,
      block.threshold,
    )
    outputPass = new OutputPass()
    composer.addPass(renderPass)
    composer.addPass(bloomPass)
    composer.addPass(outputPass)
    resize(block, true)
  }

  /**
   * Move newly-arrived UI surfaces onto `UI_LAYER`.
   *
   * A traverse per frame, with a `WeakSet` early-out, and it runs only while
   * bloom is on. The alternative — classify once, at construction — cannot work:
   * the HUD, the plates, the results panel, the hangar's labels and the title's
   * wordmark are all built later than boot, several of them on a course change
   * (DEV-077 rebuilds the world without a reload), and a surface that arrives
   * unclassified is a surface that gets ACES and a halo put on it.
   *
   * `layers.set` rather than `enable`: the object LEAVES layer 0, which is what
   * takes it out of the world pass. Nothing puts it back, and nothing needs to —
   * the camera keeps `UI_LAYER` enabled on both presets. A `Raycaster` tests
   * layer 0 only by default, so one aimed at a moved object misses it: the
   * course editor's gizmo did exactly that (DEV-472), and its ray now tests
   * every layer. Give any new ray at a `toneMapped: false` object the same.
   *
   * **One-way is also why the layer's NUMBER is a stereo question.** This runs
   * only while bloom is on and bloom is never on in VR, but a flat frame before
   * the session leaves the whole UI on `UI_LAYER` for the rest of the run — so
   * whatever that number is, both eyes have to be able to see it. See the
   * constant, and `tests/unit/xr-eye-layers.test.ts` (DEV-141).
   */
  const classify = (root: THREE.Object3D): void => {
    root.traverse((object) => {
      if (classified.has(object)) return
      classified.add(object)
      if (!isUiObject(object)) return
      object.layers.set(UI_LAYER)
      uiObjects += 1
    })
  }

  const unsubscribe = editionState.subscribe((edition) => {
    const block = edition.render.bloom
    if (!block.enabled) {
      // Off the way out, or the targets sit on the GPU for the rest of the
      // session and a flip back builds a second set.
      dropComposer()
      return
    }
    applyTuning(block)
  })

  return {
    willComposite() {
      return !renderer.xr.isPresenting && editionState.current.render.bloom.enabled
    },
    render(stage, camera) {
      // FIRST, on both presets and in VR: objects this module has moved onto the
      // UI layer stay there, so a camera that cannot see the layer is a HUD that
      // vanishes the moment somebody presses Classic.
      camera.layers.enable(UI_LAYER)

      const block = editionState.current.render.bloom
      if (renderer.xr.isPresenting || !block.enabled) return false

      if (!composer) build(block)
      if (!composer || !bloomPass) return false
      resize(block)
      applyTuning(block)
      classify(stage)

      // Everything below borrows renderer and camera state, and the `finally`
      // is what hands it back. Not defensive decoration: three throws on a lost
      // context, and an `autoReset` left false would make the perf overlay's
      // draw count climb for the rest of the session while a camera left on the
      // UI layer would render an empty world — two bugs a long way from here.
      const previousAutoClear = renderer.autoClear
      const cameraMask = camera.layers.mask
      try {
        // ── the world pass ────────────────────────────────────────────────
        //
        // `renderer.info` is zeroed by `renderer.render` itself when `autoReset`
        // is true (`three.module.js:17696`), and the composer makes SEVERAL
        // render calls — so left alone the perf overlay would report only the
        // last of them. One manual reset per frame is the same contract,
        // counted over the whole frame: the numbers on the DRAW row now include
        // the bloom's own passes, which is the honest answer to "what does this
        // cost", and DEV-091's row says so.
        renderer.info.autoReset = false
        renderer.info.reset()

        const renderPassRef = renderPass
        if (renderPassRef) {
          renderPassRef.scene = stage
          renderPassRef.camera = camera
        }
        camera.layers.disable(UI_LAYER)
        composer.render()
        camera.layers.enable(UI_LAYER)

        // ── the UI pass ───────────────────────────────────────────────────
        //
        // Straight to the canvas, so `material.toneMapped === false` means what
        // it says again, and on top, because the composer's depth stayed in its
        // own target. `clearDepth` after `autoClear = false` keeps the colour
        // that is already there and gives the UI a depth buffer of its own.
        renderer.autoClear = false
        renderer.clearDepth()
        camera.layers.set(UI_LAYER)
        renderer.render(stage, camera)
      } finally {
        camera.layers.mask = cameraMask
        renderer.autoClear = previousAutoClear
        renderer.info.autoReset = true
      }
      return true
    },
    setBloom(block) {
      if (!block.enabled) {
        dropComposer()
        return
      }
      applyTuning(block)
    },
    get report(): BloomReport {
      return { built: composer !== null, width, height, resizes, uiObjects }
    },
    dispose() {
      unsubscribe()
      dropComposer()
    },
  }
}
