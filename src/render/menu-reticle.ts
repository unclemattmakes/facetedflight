// src/render/menu-reticle.ts: a small triangle where the menus are aimed. DEV-572.
//
// Matt, 2026-10-02, on 0.17.0: *"we could use a reticle for the menus (triangle
// to stick with our polygonal theme?)"*. Until now the only mark of where you
// aimed was the laser's ring at a controller ray's end (DEV-321). A head on a
// flat screen, or a headset with its controllers asleep, aimed every menu with
// nothing on screen to say where.
//
// ── One mark, two mounts ─────────────────────────────────────────────────
//
// This file owns the triangle's LOOK: its shape, its colours, its size as an
// angle at the eye, and the material it is drawn with. Two things wear it:
//
//   the head's reticle   `createMenuReticle`, placed by `boot/app.ts` once a
//                        frame on whatever the HEAD (or a free cursor, flat)
//                        is aimed at: the screen centre when the view is
//                        captured, the cursor when it is free and over a row
//                        it can press.
//   the laser's          `render/xr-pointer.ts` builds its reticle with
//                        `createReticleMesh` too, so the ray's end in a
//                        headset is the same triangle (it was a hexagonal ring).
//
// Never both: a hand that points selects, and the laser draws its own mark, so
// the head's is put away whenever the beam is out.
//
// ── It compiles nothing (the brief: "must not compile a program when it appears") ──
//
// A program is keyed on the material's shape AND on the pass that draws it:
// the scene's light counts, its fog, the render target (CLAUDE.md, the program
// cache key traps). A reticle with a material of its own would link one program
// per stage and per binding, each the first time it was shown, in view.
//
// So it is drawn EXACTLY as the menus' own canvas plates are drawn: a `MeshBasicMaterial` with a `map`, transparent, not
// tone-mapped, fog on, front side, on a `PlaneGeometry` (position, normal, uv).
// That is the key of the hangar's table labels (`render/hangar.ts`), the pause
// plate and everything built on its painter (the title's rows, the lobby), and
// the letter plate (`render/room-code-plate.ts`). `depthTest`, `depthWrite`,
// `color` and `renderOrder` are not in three's key, and neither is a texture's
// colour space (only a video's is), so the triangle can differ in all of them.
// On the title and in the room, where nothing patches a material, that IS
// their program (measured: the title 34 programs before the triangle appears
// on a row and 34 after). `tests/unit/menu-reticle.test.ts` holds the
// parameters equal to the plates', read out of their own source.
//
// In a MISSION it is not enough, and the first photographs said so: the
// world's sweeps patch every material in the scene (`point-light-scope.ts`,
// `far-shadow.ts`), the rig's children included, and the pause plate under
// the ship is patched differently, so the first hover on the pause plate
// linked one program (163 to 164). So `boot/app.ts` also DRAWS the triangle,
// unseen, on every frame a black fade covers the screen: the stage behind the
// fade links its program there (165 to 165 at the first hover since). And
// every reticle wears ONE material (`reticleMaterial`), so the laser's mark
// shares the head's program wherever it appears.
//
// The texture is a DataTexture rasterised here, not a canvas: pure, so the
// unit suite (node, no DOM) can build it, and so can the laser's tests.
//
// ── It never hides a table's words ───────────────────────────────────────
//
// In the room the reticle draws UNDER the labels: first in three's transparent
// list (`UNDER_ORDER`, below the labels' 0), depth test off, so it lies over the
// tables and the room and the labels' lettering is painted over it. On a plate
// (the title's rows, pause, the lobby, the letter plate) it draws OVER, because
// those plates are opaque panels drawn depth-test-off at order 12, and a mark
// under one is no mark. There it sits on a row, the size of a capital at most,
// hollow, so the word reads through it.
//
// ── The look (docs/ART_DIRECTION.md) ─────────────────────────────────────
//
// UI, so `toneMapped: false`, which is what `render/bloom.ts` classifies onto
// `UI_LAYER` (3): on both eyes, never layer 1 or 2 (DEV-141). One colour,
// faceted: a hollow equilateral triangle, POINT DOWN and flat on top, with a
// dark keyline round its stroke so it reads on any colour it lies over.
//
// Matt, 2026-10-02, on the first build (point up, centred on the aim): *"flip
// the reticle in Y (have the point on the bottom, flat on top - like the
// logo)"*. The logo's own emblem is a downward chevron, flat across its top.
// And the POINT is the aim: the triangle stands on its tip, which sits exactly
// where the ray lands, and its body rises above it, so the thing that marks
// the selecting point is the sharpest part of the mark. The room's amber
// (`HOLO_COLOUR`, the tables' rim and the laser's ON) while it is on something
// a press would take, the room's dim ink (`#9fb4c4`, the header's) while it is
// not.

import * as THREE from 'three'
import { UI_ACCENT_HEX, UI_DIM_HEX } from '@/render/ui-tokens'

/**
 * The head reticle's size: its circumradius as an ANGLE AT THE EYE, radians.
 *
 * A fixed angle, so it is the same size on a table at 1.55 m and on the pause
 * plate at 0.86 m. 1.2 degrees of radius is a triangle about 2.1 degrees
 * across: on a 1280 x 720 monitor at the flat 70-degree lens about 19 px wide,
 * in a headset about a capital's height on a pause row (rows are about 6
 * degrees tall). The first cut was 0.9 degrees, and photographed over the
 * spinning jet on a table it was a speck. Larger than the laser's (`RETICLE_ANGLE` in
 * `render/xr-pointer.ts`, 0.5 degrees), because the laser has a beam leading
 * the eye to it and the head's reticle stands alone. Taste, and the number to
 * argue with.
 */
export const MENU_RETICLE_ANGLE = (1.2 * Math.PI) / 180

/**
 * The hollow: the inner triangle's circumradius as a fraction of the outer.
 * The stroke is then (1 - this) / 2 of the circumradius (an equilateral
 * triangle's inradius is half its circumradius): 0.25 at 0.5, about 2.5 px on
 * a monitor.
 */
export const RETICLE_HOLLOW = 0.5

/**
 * The KEYLINE: a dark rim round the stroke, inside and out, so the triangle
 * reads on whatever it lies over. The first photograph put the amber stroke
 * on a table's orange-and-cream aircraft, where amber on amber is nothing; a
 * one-colour mark cannot contrast with every colour in the room, and a dark
 * edge round a light one contrasts with all of them. Its width as a fraction of
 * the circumradius, and its opacity. Black in the texture, so it stays dark
 * whatever `color` tints the stroke.
 */
export const RETICLE_KEYLINE = 0.1
export const RETICLE_KEYLINE_OPACITY = 0.6

/** On something a press would take: the room's amber, the tables' rim. */
export const RETICLE_ON = UI_ACCENT_HEX
/** On nothing: the room's dim ink, the step header's. */
export const RETICLE_OFF = UI_DIM_HEX

/**
 * Under the room's labels: first in the transparent list, which the labels
 * (order 0) and every other canvas surface in the room are drawn after.
 */
export const UNDER_ORDER = -1
/**
 * Over every plate: the pause plate, the title's rows and the letter plate are
 * 12, the laser's beam 15, FF-TV's panel 20. Below the curtains (the title's
 * 9000, the vignette's fade 10000), so a fade covers it like everything else.
 */
export const OVER_ORDER = 21

/**
 * How far out the head's reticle stands when it is on nothing, metres: the
 * holotables' reach (`render/hangar.ts`, about 1.55 m). On a plate the caller
 * passes the plate's plane instead, so a miss beside a row still sits AT the
 * plate in a headset rather than floating behind it.
 */
export const REST_DISTANCE = 1.55

/** Texture side, texels. A power of two, for its mipmaps. */
const TEXELS = 64
/**
 * The triangle's circumradius as a fraction of the quad's half-width: room for
 * the keyline outside it (which adds twice its width to the circumradius, an
 * edge's distance being half of it) and a texel of clear border after that.
 */
export const RETICLE_FILL = 0.76
const FILL = RETICLE_FILL
/** Samples per texel side for the coverage. */
const SUPER = 4

/**
 * Is (x, y) inside the equilateral triangle of circumradius `r`, apex UP,
 * centroid at the origin? Its three edges stand r/2 from the centre (the
 * inradius), with unit outward normals (0, -1) for the base and
 * (+-cos 30, sin 30) for the two sides.
 */
const insideTriangle = (x: number, y: number, r: number): boolean => {
  const h = r / 2
  if (-y > h) return false
  const c = Math.cos(Math.PI / 6)
  const s = 0.5
  if (c * x + s * y > h) return false
  if (-c * x + s * y > h) return false
  return true
}

/**
 * Coverage of a hollow triangle (outer circumradius `outer`, inner `inner`,
 * in the quad's [-1, 1] units), row-major from the TOP row (canvas order), one
 * byte per texel, supersampled.
 */
const hollowTriangle = (texels: number, outer: number, inner: number): Uint8Array => {
  const out = new Uint8Array(texels * texels)
  const half = texels / 2
  for (let row = 0; row < texels; row++) {
    for (let col = 0; col < texels; col++) {
      let hits = 0
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          // Texel space to the quad's [-1, 1], y up.
          const x = (col + (sx + 0.5) / SUPER - half) / half
          const y = -(row + (sy + 0.5) / SUPER - half) / half
          // Point DOWN (Matt): the apex-up triangle, mirrored in y.
          if (insideTriangle(x, -y, outer) && !insideTriangle(x, -y, inner)) hits++
        }
      }
      out[row * texels + col] = Math.round((255 * hits) / (SUPER * SUPER))
    }
  }
  return out
}

/**
 * The STROKE's coverage: the hollow triangle itself, top row first. Pure,
 * exported for the test that reads its shape.
 */
export const reticleCoverage = (texels = TEXELS, hollow = RETICLE_HOLLOW): Uint8Array =>
  hollowTriangle(texels, FILL, FILL * hollow)

/**
 * The KEYLINE's coverage: the stroke grown by {@link RETICLE_KEYLINE} on both
 * edges. Growing an equilateral triangle's edges outward by `w` grows its
 * circumradius by `2w`; the hollow shrinks by the same.
 */
export const keylineCoverage = (texels = TEXELS, hollow = RETICLE_HOLLOW): Uint8Array => {
  const grow = 2 * RETICLE_KEYLINE * FILL
  return hollowTriangle(texels, FILL + grow, Math.max(0, FILL * hollow - grow))
}

/** The quad: a unit of local space is the triangle's circumradius. */
const QUAD = 2 / FILL

let sharedTexture: THREE.DataTexture | null = null

/**
 * The triangle as a texture: the stroke white (so `color` tints it), the
 * keyline black under and round it, straight alpha. One for the page, shared
 * by every reticle; never disposed (it is 16 KB and the page keeps it).
 */
export const reticleTexture = (): THREE.DataTexture => {
  if (sharedTexture) return sharedTexture
  const stroke = reticleCoverage()
  const keyline = keylineCoverage()
  const data = new Uint8Array(TEXELS * TEXELS * 4)
  for (let i = 0; i < TEXELS * TEXELS; i++) {
    // DataTexture rows run bottom-up (flipY is false for it): row 0 of the
    // upload is the BOTTOM of the image, and the coverages are top-down.
    const row = Math.floor(i / TEXELS)
    const col = i % TEXELS
    const at = (TEXELS - 1 - row) * TEXELS + col
    const s = (stroke[at] as number) / 255
    const k = ((keyline[at] as number) / 255) * RETICLE_KEYLINE_OPACITY
    // The stroke over the keyline: white at `s`, black at `k` under it.
    const alpha = s + (1 - s) * k
    // Straight alpha: the colour is the white's share of what is there. Black
    // where nothing is, so filtering pulls the keyline's dark, not a white
    // fringe, in from the clear texels.
    const white = alpha > 0 ? s / alpha : 0
    data[i * 4] = Math.round(255 * white)
    data[i * 4 + 1] = Math.round(255 * white)
    data[i * 4 + 2] = Math.round(255 * white)
    data[i * 4 + 3] = Math.round(255 * alpha)
  }
  const texture = new THREE.DataTexture(data, TEXELS, TEXELS, THREE.RGBAFormat)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  texture.name = 'menu-reticle'
  sharedTexture = texture
  return texture
}

/**
 * The material, in the canvas plates' program key (see the header): a map,
 * transparent, not tone-mapped, fog left ON as theirs is, front side. Depth
 * test and write off, which the key does not see.
 */
export const createReticleMaterial = (): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    map: reticleTexture(),
    color: RETICLE_ON,
    transparent: true,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  })

let sharedMaterial: THREE.MeshBasicMaterial | null = null

/**
 * The ONE material every reticle wears, the head's and the laser's: one
 * material is one program per stage and binding, whatever the world's sweeps do
 * to it, so the laser's mark can never link a program the head's has not. Two
 * instances of the same parameters were measured to differ in a headset (the
 * laser's first show linked one, 259 to 260 programs). The two are never shown
 * in one frame except under a black fade, so one colour uniform serves both.
 * Never disposed, like the texture.
 */
export const reticleMaterial = (): THREE.MeshBasicMaterial => {
  if (!sharedMaterial) sharedMaterial = createReticleMaterial()
  return sharedMaterial
}

/**
 * A reticle mesh: the triangle on a quad in its own z = 0 plane, facing +z,
 * its flat edge across the top and its POINT at the local origin, the body
 * rising along +y, with ONE local unit = the triangle's circumradius. So a
 * scale of `r` is a triangle of circumradius `r` standing on the point the
 * object is placed at. Named `name`, drawn `OVER_ORDER`, on the shared
 * {@link reticleMaterial}.
 */
export const createReticleMesh = (
  name: string,
): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> => {
  // The tip is one circumradius under the centroid; lift the quad by that so
  // the tip, not the middle, is where the mesh stands.
  const geometry = new THREE.PlaneGeometry(QUAD, QUAD).translate(0, 1, 0)
  const mesh = new THREE.Mesh(geometry, reticleMaterial())
  mesh.name = name
  mesh.renderOrder = OVER_ORDER
  mesh.frustumCulled = false
  return mesh
}

/** Where a reticle draws: over a plate, or under the room's words. */
export type ReticleLayer = 'over' | 'under'

export interface MenuReticle {
  /** Parent this to `render.rig`, once: the rig is in whichever stage is drawn. */
  readonly object: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  /**
   * Stand the triangle `distance` metres along the WORLD ray (`origin`,
   * unit `direction`), facing `eye`, sized {@link MENU_RETICLE_ANGLE} at the
   * eye. `on`: it is on something a press would take (the amber); otherwise
   * the dim ink. `layer`: under the room's labels or over a plate.
   */
  place(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    eye: THREE.Vector3,
    on: boolean,
    layer: ReticleLayer,
  ): void
  /** Put it away. The frame does this whenever no menu is aimed. */
  hide(): void
  dispose(): void
}

// Volatile, valid only inside one synchronous call (trap 19).
const _point = new THREE.Vector3()
const _local = new THREE.Vector3()
const _scale = new THREE.Vector3()

/** The head's reticle (DEV-572). See the header. */
export const createMenuReticle = (): MenuReticle => {
  const object = createReticleMesh('menu-reticle')
  object.visible = false
  // Read by e2e through `__ff2`: whether it is up, on something, how far,
  // and which side of the words. A spec asserting `visible` alone would pass
  // on a reticle pointing at the floor.
  const report = (on: boolean, distance: number | null, layer: ReticleLayer | null): void => {
    object.userData.on = on
    object.userData.distance = distance
    object.userData.layer = layer
  }
  report(false, null, null)
  return {
    object,
    place(origin, direction, distance, eye, on, layer) {
      _point.copy(origin).addScaledVector(direction, distance)
      const parent = object.parent
      if (parent) {
        parent.updateWorldMatrix(true, false)
        _local.copy(_point)
        parent.worldToLocal(_local)
        object.position.copy(_local)
      } else object.position.copy(_point)
      // `lookAt` turns +z toward the target in WORLD terms, parent included,
      // and keeps the object's up (world +y): the body rises from the tip.
      object.lookAt(eye)
      const unit = parent ? parent.getWorldScale(_scale).x : 1
      object.scale.setScalar((Math.tan(MENU_RETICLE_ANGLE) * _point.distanceTo(eye)) / unit)
      object.material.color.setHex(on ? RETICLE_ON : RETICLE_OFF)
      object.renderOrder = layer === 'under' ? UNDER_ORDER : OVER_ORDER
      object.visible = true
      report(on, distance, layer)
    },
    hide() {
      object.visible = false
      report(false, null, null)
    },
    dispose() {
      object.removeFromParent()
      object.geometry.dispose()
      // Not the material: it is every reticle's (`reticleMaterial`).
    },
  }
}
