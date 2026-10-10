// tests/unit/bloom.test.ts — the flat build's bloom (DEV-091).
//
// Four things, in the order they would hurt if they broke.
//
//  1. **It never runs in VR.** A post pass under `renderer.xr` means an
//     off-screen target per eye and the loss of the compositor's direct path, on
//     the platform M3 is fighting for 72 Hz (PORT_PLAN §6.1, R6). It is also what
//     2016 did — the component sat on the MONO camera and `CameraMode.cs` boots
//     with `vrMode = true` (`render/bloom.ts` carries the trace). So "never in
//     VR" gets an assertion rather than a comment: with `isPresenting` true,
//     `render()` answers false, builds nothing, and the caller's own
//     `renderer.render` is what draws.
//
//  2. **Classic builds nothing at all.** Not "a composer that does nothing" — no
//     composer, no render target, no MSAA buffer for the life of the session. The
//     assertion is `report.built`, which is a stronger claim than "the frame
//     looks the same".
//
//  3. **The UI exemption holds, on the SCENE GRAPH.** `material.toneMapped`
//     cannot carry it inside a render target (three applies the curve only to the
//     canvas or an XR target), so the split is a layer, and what is asserted is
//     the property that makes it true: every surface on `render/tone.ts`'s line
//     leaves layer 0 for `UI_LAYER`, nothing else moves, and the LAST render call
//     of the frame is the game camera with a mask of exactly that layer.
//
//  4. **The composer follows the DRAWING BUFFER.** `render/quality.ts` steps the
//     pixel ratio down live when the frame budget runs out, and a bloom left at a
//     stale size is not an error and logs nothing — it is a blurry frame.
//
// No GL context. The renderer is a plain object with the dozen methods three's
// own passes reach for, which is enough to drive the whole chain in node: every
// `WebGLRenderTarget`, `ShaderMaterial` and `FullScreenQuad` in it is pure
// JavaScript until something actually uploads. If a three upgrade changes which
// renderer methods a pass calls, this file goes red — which is the point of
// "every dependency upgrade lands alone, with a measured result".

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { type BloomRenderer, createBloom, isUiObject, UI_LAYER } from '@/render/bloom'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

interface RenderCall {
  readonly scene: THREE.Object3D
  readonly camera: THREE.Camera
  /** The camera's layer mask AT THE MOMENT of the call, not afterwards. */
  readonly mask: number
  readonly autoClear: boolean
}

interface FakeRenderer extends BloomRenderer {
  readonly calls: RenderCall[]
  /** `getDrawingBufferSize` answers this; move it to fake a resolution step. */
  size: { x: number; y: number }
  resets: number
  depthClears: number
  xr: { isPresenting: boolean }
  info: { autoReset: boolean; reset(): void }
}

/**
 * Everything three's own passes touch, and nothing else.
 *
 * `setRenderTarget`, `clear` and the four clear-colour accessors are
 * `RenderPass`'s and `UnrealBloomPass`'s; `outputColorSpace`, `toneMapping` and
 * `toneMappingExposure` are `OutputPass`'s, which reads them off the renderer on
 * every frame — that is what keeps `attachEditionTone` in charge of the curve.
 */
const fakeRenderer = (presenting = false): FakeRenderer => {
  const calls: RenderCall[] = []
  const clearColor = new THREE.Color(0, 0, 0)
  const self = {
    calls,
    size: { x: 1280, y: 720 },
    resets: 0,
    depthClears: 0,
    autoClear: true,
    xr: { isPresenting: presenting },
    info: {
      autoReset: true,
      reset() {
        self.resets += 1
      },
    },
    // OutputPass reads these three every frame; `applyEditionRender` owns them.
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
    getDrawingBufferSize(target: THREE.Vector2) {
      return target.set(self.size.x, self.size.y)
    },
    getSize(target: THREE.Vector2) {
      return target.set(self.size.x, self.size.y)
    },
    getPixelRatio: () => 1,
    clearDepth() {
      self.depthClears += 1
    },
    clear() {},
    setRenderTarget() {},
    getRenderTarget: () => null,
    getClearColor: (target: THREE.Color) => target.copy(clearColor),
    getClearAlpha: () => 1,
    setClearColor() {},
    setClearAlpha() {},
    render(scene: THREE.Object3D, camera: THREE.Camera) {
      calls.push({ scene, camera, mask: camera.layers.mask, autoClear: self.autoClear })
    },
  }
  return self as unknown as FakeRenderer
}

/** A stage with one world surface and two UI surfaces, as the game has. */
const stageWith = (): {
  stage: THREE.Scene
  world: THREE.Mesh
  hud: THREE.Mesh
  plate: THREE.Mesh
} => {
  const stage = new THREE.Scene()
  const world = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  world.name = 'terrain-chunk'
  // Exactly what `render/hud.ts` and `render/pause.ts` build: a canvas texture on
  // an unlit material, `toneMapped: false`.
  const hud = new THREE.Mesh(
    new THREE.PlaneGeometry(),
    new THREE.MeshBasicMaterial({ toneMapped: false }),
  )
  hud.name = 'hud'
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(),
    new THREE.MeshBasicMaterial({ toneMapped: false }),
  )
  plate.name = 'pause-plate'
  // Nested, because the real ones are: the HUD hangs off the ship group.
  const ship = new THREE.Group()
  ship.add(hud)
  stage.add(world, ship, plate)
  return { stage, world, hud, plate }
}

const camera = (): THREE.PerspectiveCamera => new THREE.PerspectiveCamera()

describe('bloom never runs in VR — DEV-091', () => {
  it('answers false while presenting, and builds no composer', () => {
    const renderer = fakeRenderer(true)
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const bloom = createBloom(renderer, state)
    const { stage } = stageWith()
    const cam = camera()

    expect(bloom.render(stage, cam)).toBe(false)
    expect(bloom.report.built).toBe(false)
    // Nothing was drawn by this module: the caller's own direct render is what
    // draws in VR, and it has not happened yet.
    expect(renderer.calls).toHaveLength(0)
    bloom.dispose()
  })

  it('leaves the UI layer visible to the camera even in VR', () => {
    // The one thing it MUST still do while presenting. Classification is sticky,
    // so a session that flipped to Classic or entered VR with UI already on the
    // layer needs a camera that can see it, or the HUD vanishes.
    const renderer = fakeRenderer(true)
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const cam = camera()
    bloom.render(new THREE.Scene(), cam)
    expect(cam.layers.isEnabled(UI_LAYER)).toBe(true)
    bloom.dispose()
  })
})

describe('Classic constructs nothing — DEV-091', () => {
  it('never builds a composer, however many frames run', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(classic, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    for (let i = 0; i < 5; i += 1) expect(bloom.render(stage, cam)).toBe(false)
    expect(bloom.report.built).toBe(false)
    expect(bloom.report.resizes).toBe(0)
    // And it classified nothing: on Classic the scene graph is untouched, so the
    // HUD is still on layer 0 exactly as `renderer.render` has always found it.
    expect(bloom.report.uiObjects).toBe(0)
    expect(renderer.calls).toHaveLength(0)
    bloom.dispose()
  })

  it('has a block that is a no-op by its NUMBERS as well as its flag', () => {
    // The same belt and braces the haze and the coast rows use: a hand-flipped
    // flag must not turn on a bloom nobody tuned. Strength 0 adds nothing at any
    // threshold, and 0.63 is recorded so 2016's one transferable number is not
    // lost on a disabled block.
    expect(classic.render.bloom.enabled).toBe(false)
    expect(classic.render.bloom.strength).toBe(0)
    expect(classic.render.bloom.threshold).toBe(0.63)
  })
})

describe('the UI exemption is a layer, and it holds — DEV-091', () => {
  it('reads the flag off the material, array or not', () => {
    const lit = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const ui = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    )
    const mixed = new THREE.Mesh(new THREE.BoxGeometry(), [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    ])
    expect(isUiObject(lit)).toBe(false)
    expect(isUiObject(ui)).toBe(true)
    expect(isUiObject(mixed)).toBe(true)
    expect(isUiObject(new THREE.Group())).toBe(false)
  })

  it('moves every UI surface OFF layer 0, and nothing else', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage, world, hud, plate } = stageWith()
    const cam = camera()
    expect(bloom.render(stage, cam)).toBe(true)

    for (const ui of [hud, plate]) {
      expect(ui.layers.isEnabled(UI_LAYER), ui.name).toBe(true)
      // OFF layer 0 is the half that does the work: that is what takes it out of
      // the world pass and therefore out of the bloom's high pass.
      expect(ui.layers.isEnabled(0), ui.name).toBe(false)
    }
    expect(world.layers.isEnabled(0)).toBe(true)
    expect(world.layers.isEnabled(UI_LAYER)).toBe(false)
    expect(bloom.report.uiObjects).toBe(2)
    bloom.dispose()
  })

  it('draws the UI LAST, on the UI layer alone, over a preserved frame', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)

    const last = renderer.calls.at(-1)
    expect(last?.scene).toBe(stage)
    expect(last?.camera).toBe(cam)
    // Exactly the UI layer — not "the UI layer among others", which would draw
    // the world twice and put the bloom's own output underneath a second copy.
    expect(last?.mask).toBe(1 << UI_LAYER)
    // And it did not wipe what the composer had just composited.
    expect(last?.autoClear).toBe(false)
    expect(renderer.depthClears).toBe(1)
    // Restored afterwards: the direct path in a later frame — a flip to Classic,
    // or entering VR — must find the renderer as it left it.
    expect(renderer.autoClear).toBe(true)
    expect(renderer.info.autoReset).toBe(true)
    bloom.dispose()
  })

  it('renders the world with the UI layer OFF the camera', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)

    // The composer's `RenderPass` is the first call that draws the stage; its
    // mask is what decides whether the HUD reaches the bloom's high pass.
    const worldPass = renderer.calls.find((c) => c.scene === stage)
    expect(worldPass).toBeDefined()
    expect(worldPass?.mask).toBe(1)
    expect(cam.layers.isEnabled(UI_LAYER)).toBe(true)
    bloom.dispose()
  })

  it('classifies a surface that arrives LATER — the plates are built late', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)
    expect(bloom.report.uiObjects).toBe(2)

    // The results panel, built when a run ends — several minutes after boot, and
    // again after a course change that does not reload (DEV-077).
    const results = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
    )
    stage.add(results)
    bloom.render(stage, cam)
    expect(bloom.report.uiObjects).toBe(3)
    expect(results.layers.isEnabled(UI_LAYER)).toBe(true)
    expect(results.layers.isEnabled(0)).toBe(false)
    bloom.dispose()
  })
})

describe('the composer follows the drawing buffer — DEV-091', () => {
  it('sizes to the buffer at first sight and re-sizes when it steps', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)
    expect(bloom.report).toMatchObject({ built: true, width: 1280, height: 720, resizes: 1 })

    // Same size, more frames: nothing is re-allocated.
    bloom.render(stage, cam)
    bloom.render(stage, cam)
    expect(bloom.report.resizes).toBe(1)

    // `ADAPTIVE_STEPS[1]` is 0.9 — the first step adaptive resolution takes when
    // the frame budget runs out. Nothing announces it; the composer has to look.
    renderer.size = { x: 1152, y: 648 }
    bloom.render(stage, cam)
    expect(bloom.report).toMatchObject({ width: 1152, height: 648, resizes: 2 })
    bloom.dispose()
  })
})

describe('a flip does not leak — DEV-091', () => {
  it('drops the composer on the way to Classic and rebuilds on the way back', () => {
    const renderer = fakeRenderer()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const bloom = createBloom(renderer, state)
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)
    expect(bloom.report.built).toBe(true)

    state.setLook(classic)
    // Disposed on the SUBSCRIPTION, not lazily on the next frame: a paused game
    // that never draws again would otherwise hold six render targets for ever.
    expect(bloom.report.built).toBe(false)
    expect(bloom.render(stage, cam)).toBe(false)

    state.setLook(anniversary)
    expect(bloom.render(stage, cam)).toBe(true)
    expect(bloom.report.built).toBe(true)
    bloom.dispose()
    expect(bloom.report.built).toBe(false)
  })

  it('puts the live numbers on the pass without rebuilding it', () => {
    const renderer = fakeRenderer()
    const bloom = createBloom(renderer, createEditionState(anniversary, DEFAULT_SETTINGS))
    const { stage } = stageWith()
    const cam = camera()
    bloom.render(stage, cam)
    const resizes = bloom.report.resizes

    // The lookdev panel's three sliders. Uniforms, not textures: no resize.
    bloom.setBloom({ ...anniversary.render.bloom, threshold: 0.4, strength: 0.3, radius: 0.6 })
    expect(bloom.report.resizes).toBe(resizes)

    // `resolutionScale` is the exception — it is a texture size.
    bloom.setBloom({ ...anniversary.render.bloom, resolutionScale: 0.5 })
    expect(bloom.report.resizes).toBe(resizes + 1)
    bloom.dispose()
  })
})

describe('the preset refuses a hole in the bloom — DEV-091', () => {
  const withBloom = (patch: Record<string, unknown>): Edition =>
    ({
      ...anniversary,
      render: { ...anniversary.render, bloom: { ...anniversary.render.bloom, ...patch } },
    }) as unknown as Edition

  it('names the key rather than rendering nothing', () => {
    // A missing `threshold` reaches `smoothstep(undefined, undefined + 0.01, v)`
    // as a NaN, and a NaN alpha in the high pass is a BLACK bloom buffer added to
    // the frame — the feature silently does nothing and looks unimplemented.
    const holed = withBloom({}) as unknown as { render: { bloom: Record<string, unknown> } }
    delete holed.render.bloom.threshold
    expect(() => validateEdition(holed as unknown as Edition)).toThrow(/render\.bloom\.threshold/)
  })

  it('refuses a radius outside 0..1, which SUBTRACTS light', () => {
    // `lerpBloomFactor(f) = mix(f, 1.2 - f, radius)`: past 1 the mix walks beyond
    // its own endpoints and the wide mips go negative.
    expect(() => validateEdition(withBloom({ radius: 1.4 }))).toThrow(/render\.bloom\.radius/)
  })

  it('refuses a resolutionScale of zero, which glows two texels', () => {
    expect(() => validateEdition(withBloom({ resolutionScale: 0 }))).toThrow(
      /render\.bloom\.resolutionScale/,
    )
  })

  it('refuses a negative strength', () => {
    expect(() => validateEdition(withBloom({ strength: -0.2 }))).toThrow(/render\.bloom\.strength/)
  })
})
