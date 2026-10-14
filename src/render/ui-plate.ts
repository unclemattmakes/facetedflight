// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/render/ui-plate.ts: the canvas plate: a canvas, its texture, the unlit UI
// material and a plane, built once.
//
// Ten plates (pause, results and its board, briefing, the XR checklist that
// DEV-900 removed, perf, room code, credits) each wrote the same 20 lines, and two of them wrote the same TRAP
// twice and explained it once. Here it is, once:
//
// ── A canvas whose size changed needs a NEW texture ──────────────────────────
//
// The GPU-side texture has the old dimensions, and three re-allocates it only
// when the `Texture` OBJECT changes. Setting `needsUpdate` on the old one uploads
// the new pixels into the old allocation and the plate comes out squashed, which
// looks like a layout bug and is not one. `resize()` does the whole rebuild, so
// a third panel that grows does not have to rediscover it.
//
// ── `toneMapped: false` is load-bearing twice ───────────────────────────────
//
// `render/bloom.ts`'s `classify()` keys on it to move the mesh onto `UI_LAYER`
// (3), and layers 1 and 2 are the WebXR EYES: a plate on either is ABSENT from
// the other eye (DEV-141). It also exempts the canvas from the Anniversary tone
// curve (`render/tone.ts`, DEV-081). The material below is built here and
// nowhere a caller can forget it, and `tests/unit/ui-plate.test.ts` asserts it.
//
// Every plate this makes is an OVERLAY: `depthTest: false`, so a strut in front
// of a menu does not hide the menu. World-anchored signs (the title's wordmark,
// the bench door) are depth-tested and are not built here. The HUD's surface
// owns raster-mode context options and mip state (DEV-256) and stays its own.

import * as THREE from 'three'

/** The plates' texel density: the HUD's, so type is one size across panels. */
export const UI_PIXELS_PER_METRE = 1400

/** A canvas as a texture the way every UI plate wants it: sRGB, anisotropic. */
export const createUiTexture = (canvas: HTMLCanvasElement, anisotropy = 4): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas)
  // Authored in sRGB, like any canvas.
  texture.colorSpace = THREE.SRGBColorSpace
  // Small type read at a rake.
  texture.anisotropy = anisotropy
  return texture
}

/** The unlit overlay material: see the header for what each flag is for. */
export const createUiMaterial = (map: THREE.Texture): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    depthTest: false,
  })

export interface UiPlateSpec {
  /** The mesh's name: what a spec finds it by. */
  readonly name: string
  readonly widthM: number
  /** The first height, metres. The canvas is sized from it and so is the plane. */
  readonly heightM: number
  /** A stacking contract (HUD 10, results 11, pause 12): pass it, there is no default. */
  readonly renderOrder: number
  /** Default {@link UI_PIXELS_PER_METRE}. */
  readonly pxPerM?: number
  /** Default 4. */
  readonly anisotropy?: number
  /**
   * The plane for a plate `heightM` tall. Default: centred. The pause plate and
   * the code plate translate theirs so the TOP EDGE sits at a fixed anchor and
   * the plate grows downward.
   */
  readonly geometry?: (heightM: number) => THREE.PlaneGeometry
}

export interface UiPlate {
  readonly object: THREE.Mesh
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  readonly material: THREE.MeshBasicMaterial
  /** The CURRENT texture: `resize()` replaces it. */
  readonly texture: THREE.CanvasTexture
  /** Re-size the canvas and plane to `heightM`, with a new texture. The caller redraws. */
  resize(heightM: number): void
  /** Upload what was drawn. Call at the end of a draw. */
  commit(): void
  dispose(): void
}

export const createUiPlate = (spec: UiPlateSpec): UiPlate => {
  const pxPerM = spec.pxPerM ?? UI_PIXELS_PER_METRE
  const anisotropy = spec.anisotropy ?? 4
  const buildGeometry = (heightM: number): THREE.PlaneGeometry =>
    spec.geometry ? spec.geometry(heightM) : new THREE.PlaneGeometry(spec.widthM, heightM)

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(spec.widthM * pxPerM)
  canvas.height = Math.round(spec.heightM * pxPerM)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(`${spec.name}: no 2d context`)

  let texture = createUiTexture(canvas, anisotropy)
  const material = createUiMaterial(texture)

  const object = new THREE.Mesh(buildGeometry(spec.heightM), material)
  object.name = spec.name
  object.renderOrder = spec.renderOrder
  object.visible = false

  return {
    object,
    canvas,
    ctx,
    material,
    get texture() {
      return texture
    },
    resize(heightM) {
      object.geometry.dispose()
      object.geometry = buildGeometry(heightM)
      canvas.height = Math.round(heightM * pxPerM)
      // The trap in the header: a NEW texture, not `needsUpdate` on the old one.
      texture.dispose()
      texture = createUiTexture(canvas, anisotropy)
      material.map = texture
      material.needsUpdate = true
    },
    commit() {
      texture.needsUpdate = true
    },
    dispose() {
      texture.dispose()
      material.dispose()
      object.geometry.dispose()
    },
  }
}
