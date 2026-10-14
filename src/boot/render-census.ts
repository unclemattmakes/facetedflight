// src/boot/render-census.ts — what one frame drew, by group, and how many
// times over it painted each pixel.
//
// DEV-118. Matt: *"investigate how we can improve performance (assuming
// overdraw and draw calls aren't great)"*. `renderer.info` answers "how many
// draw calls" for the whole frame and nothing about WHOSE they are; the perf
// overlay (`perf-hud.ts`) shows the totals. This is the attribution: it reads
// three's own render list for the frame just drawn — the exact set of draw
// calls the renderer issued, after culling, in the order it drew them — and
// folds it by the top-level group each object hangs under, so "terrain 96
// calls / 1.2 M tris, ocean 48 / 0.3 M, props 6 / 0.4 M" is a fact rather
// than a guess from the scene graph. Nothing here re-derives culling.
//
// ── Overdraw is MEASURED, not estimated ───────────────────────────────────
//
// A bounding-sphere projection would be a guess. Instead the scene is drawn
// again with an override material that adds exactly 1/255 to a linear 8-bit
// target for every fragment, front faces only (the real frame culls the
// back), and the pixels are read back: the red channel IS the number of times
// that pixel was painted (saturating at 255). Two draws, two numbers:
//
//   ISSUED  depth test off — every fragment the rasteriser produced. This is
//           the classic overdraw view, and it is what a tiled GPU without
//           early-Z pays for.
//   SHADED  depth test and write on, in three's own draw order — fragments
//           that reached the shader after early-Z rejected the rest. Closer to
//           what a desktop or a Quest actually shades for the OPAQUE pass;
//           transparent draws never write depth and always shade.
//
// Both are means over the target — 1.0 is every pixel painted once — and each
// is taken again with the frame's transparent objects hidden, which is the
// opaque figure. The target is small on purpose (a 320-wide thumbnail of the
// viewport's aspect): overdraw is a ratio, the readback has to be cheap, and
// the shape of the number does not change with resolution.
//
// ── Why the census draws a frame of its own ──────────────────────────────
//
// three keeps one render list per scene per depth, and the LAST render of the
// scene owns it. On the composer path that is the bloom's second pass — the UI
// layer alone, drawn over the composite — so reading the leftover list gave one
// call (the HUD) and none of the world. The census renders the scene itself
// into the same small target, with the real materials and the camera as it
// stands, and reads the list that render produced. One extra draw of the
// frame, only when something asks.
//
// The override skips every custom vertex shader (the water lies flat, the
// clouds do not billow), which moves a few edge pixels and no area. It is a
// diagnostic and runs only when something asks for it — `__ff2.census()` — so
// it costs the running game nothing.

import * as THREE from 'three'

export interface CensusRow {
  /** The child of the scene the object hangs under — `world-terrain`, `hud`, ... */
  readonly group: string
  readonly calls: number
  readonly triangles: number
  /** How many of those calls were transparent-pass draws. */
  readonly transparentCalls: number
}

export interface Overdraw {
  /** Mean fragments ISSUED per pixel (depth test off), all draws. 1 is one paint per pixel. */
  readonly issued: number
  /** Issued, with the frame's transparent objects hidden. */
  readonly issuedOpaque: number
  /** Mean fragments that passed a depth test in draw order — what got SHADED. */
  readonly shaded: number
  /** Shaded, opaque draws only. */
  readonly shadedOpaque: number
  /** The most-painted pixel (issued), saturating at 255. */
  readonly max: number
}

export interface Census {
  readonly calls: number
  readonly triangles: number
  readonly programs: number
  readonly geometries: number
  readonly textures: number
  /** Sorted by triangles, descending. */
  readonly rows: readonly CensusRow[]
  readonly overdraw: Overdraw
}

/** The shape of a three render item this reads. Structural, so a test can fake it. */
export interface CensusItem {
  readonly object: THREE.Object3D
  readonly geometry: THREE.BufferGeometry | null
  readonly material: THREE.Material
  readonly group: { start: number; count: number } | null
}

/**
 * Triangles one `BatchedMesh` draw submits: the multi-draw counts its last
 * `onBeforeRender` recorded, summed. Those are private to three
 * (`_multiDrawCounts`, `_multiDrawCount`), so they are read structurally and a
 * missing field reads as 0 rather than as a guess; `tests/unit/render-census
 * .test.ts` pins the shape against the real class so an upgrade that renames
 * them fails there.
 */
export const batchedTriangles = (batch: THREE.BatchedMesh): number => {
  const shape = batch as unknown as { _multiDrawCounts?: Int32Array; _multiDrawCount?: number }
  const counts = shape._multiDrawCounts
  const n = shape._multiDrawCount
  if (!counts || typeof n !== 'number') return 0
  let vertices = 0
  for (let i = 0; i < n; i++) vertices += counts[i] as number
  return Math.floor(vertices / 3)
}

/** Triangles one draw of `item` issues: draw range or full geometry, times instances. */
export const itemTriangles = (item: CensusItem): number => {
  const g = item.geometry
  if (!g) return 0
  // DEV-904. A `BatchedMesh`'s geometry is its whole RESERVED buffer, free slots
  // and all (DEV-193 section 4: 280 k triangles reported for the 182 k a frame
  // submitted). What it submitted is the sum of the draw ranges `onBeforeRender`
  // last built for the camera in use, and the census renders with its own, so
  // after that render these are the frame's.
  const batched = item.object as THREE.BatchedMesh
  if (batched.isBatchedMesh) return batchedTriangles(batched)
  const index = g.index
  const position = g.attributes.position
  const total = index ? index.count : position ? position.count : 0
  const range = g.drawRange
  const rangeCount = Math.min(range.count, total - Math.min(range.start, total))
  const count = item.group ? Math.min(item.group.count, rangeCount) : rangeCount
  const instances = (item.object as THREE.InstancedMesh).isInstancedMesh
    ? (item.object as THREE.InstancedMesh).count
    : 1
  return Math.floor(count / 3) * instances
}

/** The scene child an object hangs under, by name; the scene itself for a direct child. */
export const topGroupName = (object: THREE.Object3D, scene: THREE.Object3D): string => {
  let n: THREE.Object3D = object
  while (n.parent && n.parent !== scene) n = n.parent
  return n.name || n.type
}

/**
 * The row key: the top group, and for the land terrain one level more — the
 * props hang under `world-terrain` (DEV-089), and a census that folded 64
 * chunks and every scattered palm into one row would answer the question it
 * was asked with the sum of two different answers. Chunk meshes collapse to
 * `chunks` whatever their coordinates.
 */
export const rowKey = (object: THREE.Object3D, scene: THREE.Object3D): string => {
  const top = topGroupName(object, scene)
  if (top !== 'world-terrain') return top
  let n: THREE.Object3D = object
  while (n.parent && n.parent.parent !== scene) n = n.parent
  // DEV-904: the land's LOD batches (`chunks_batch_N`) are the chunks, drawn
  // another way, so they fold into the same row. A before and after of the
  // chunk grid is then a diff of one row, and `census-baseline`'s key holds.
  const second =
    n === object && /^chunk_\d+_\d+$|^chunks_batch_\d+$/.test(n.name) ? 'chunks' : n.name || n.type
  return `${top}/${second}`
}

/**
 * Fold render items into rows by top-level group. Pure: hand it any list.
 *
 * `transparent` marks which items came out of the transparent pass — three
 * splits the list by `material.transparent`, so the caller passes both halves.
 */
export const censusRows = (
  scene: THREE.Object3D,
  opaque: readonly CensusItem[],
  transparent: readonly CensusItem[],
): CensusRow[] => {
  const rows = new Map<string, { calls: number; triangles: number; transparentCalls: number }>()
  const add = (item: CensusItem, isTransparent: boolean): void => {
    // DEV-785: an InstancedMesh whose count is 0 is in the render list but three
    // issues no draw for it (`WebGLBufferRenderer.renderInstances` returns before
    // it counts one). A cloud-pool member sets its count to 0 on a pass that sees
    // none of its clouds, so it is not a call.
    const instanced = item.object as THREE.InstancedMesh
    if (instanced.isInstancedMesh && instanced.count === 0) return
    const key = rowKey(item.object, scene)
    const row = rows.get(key) ?? { calls: 0, triangles: 0, transparentCalls: 0 }
    row.calls++
    row.triangles += itemTriangles(item)
    if (isTransparent) row.transparentCalls++
    rows.set(key, row)
  }
  for (const item of opaque) add(item, false)
  for (const item of transparent) add(item, true)
  return [...rows.entries()]
    .map(([group, r]) => ({ group, ...r }))
    .sort((a, b) => b.triangles - a.triangles)
}

/** Width of the overdraw target. Height follows the camera's aspect. */
const OVERDRAW_WIDTH = 320

let overdrawTarget: THREE.WebGLRenderTarget | null = null
let issuedMaterial: THREE.MeshBasicMaterial | null = null
let shadedMaterial: THREE.MeshBasicMaterial | null = null

const countingMaterial = (depth: boolean): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    // 1/255 per fragment into an 8-bit linear target: the red byte counts.
    color: new THREE.Color(1 / 255, 0, 0),
    blending: THREE.AdditiveBlending,
    // `transparent` decides which pass three sorts the draw into. The SHADED
    // count wants three's real order — opaque front-to-back, then transparent
    // — so it is left false there and the additive blend carries the count.
    transparent: !depth,
    depthTest: depth,
    depthWrite: depth,
    side: THREE.FrontSide,
    toneMapped: false,
    fog: false,
  })

const overdrawResources = (aspect: number) => {
  const height = Math.max(1, Math.round(OVERDRAW_WIDTH / aspect))
  if (!overdrawTarget || overdrawTarget.height !== height) {
    overdrawTarget?.dispose()
    overdrawTarget = new THREE.WebGLRenderTarget(OVERDRAW_WIDTH, height, {
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    })
  }
  issuedMaterial ??= countingMaterial(false)
  shadedMaterial ??= countingMaterial(true)
  return { target: overdrawTarget, issued: issuedMaterial, shaded: shadedMaterial }
}

/** Draw the scene into the small target, with an override or the real materials. */
const drawInto = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget,
  override: THREE.Material | null,
  hide: readonly THREE.Object3D[],
  body: () => void,
): void => {
  const previousTarget = renderer.getRenderTarget()
  const previousOverride = scene.overrideMaterial
  const previousBackground = scene.background
  const previousToneMapping = renderer.toneMapping
  const hidden: [THREE.Object3D, boolean][] = hide.map((o) => [o, o.visible])
  try {
    for (const o of hide) o.visible = false
    scene.overrideMaterial = override
    if (override) scene.background = null
    if (override) renderer.toneMapping = THREE.NoToneMapping
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear(true, true, true)
    renderer.render(scene, camera)
    body()
  } finally {
    renderer.setRenderTarget(previousTarget)
    scene.overrideMaterial = previousOverride
    scene.background = previousBackground
    renderer.toneMapping = previousToneMapping
    for (const [o, was] of hidden) o.visible = was
  }
}

/** Draw the scene with a counting override and read the mean/max paint count. */
const measureOverdraw = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  target: THREE.WebGLRenderTarget,
  material: THREE.Material,
  hide: readonly THREE.Object3D[],
): { mean: number; max: number } => {
  let mean = 0
  let max = 0
  drawInto(renderer, scene, camera, target, material, hide, () => {
    const pixels = new Uint8Array(target.width * target.height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
    let sum = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const v = pixels[i] as number
      sum += v
      if (v > max) max = v
    }
    mean = sum / (target.width * target.height)
  })
  return { mean, max }
}

/**
 * Draw one frame of `scene` off-screen, take the census of what it drew, then
 * measure overdraw. Between frames only — from the console or a spec on a
 * `?snap=` frozen frame — never inside the loop.
 */
export const renderCensus = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Census => {
  const aspect = (camera as THREE.PerspectiveCamera).aspect || 16 / 9
  const { target, issued, shaded } = overdrawResources(aspect)

  let opaque: CensusItem[] = []
  let transparent: CensusItem[] = []
  drawInto(renderer, scene, camera, target, null, [], () => {
    const list = renderer.renderLists.get(scene, 0)
    opaque = [...list.opaque, ...list.transmissive] as unknown as CensusItem[]
    transparent = [...list.transparent] as unknown as CensusItem[]
  })
  const rows = censusRows(scene, opaque, transparent)
  const transparentObjects = [...new Set(transparent.map((i) => i.object))]

  const issuedAll = measureOverdraw(renderer, scene, camera, target, issued, [])
  const issuedOpaque = measureOverdraw(renderer, scene, camera, target, issued, transparentObjects)
  const shadedAll = measureOverdraw(renderer, scene, camera, target, shaded, [])
  const shadedOpaque = measureOverdraw(renderer, scene, camera, target, shaded, transparentObjects)

  return {
    calls: rows.reduce((n, r) => n + r.calls, 0),
    triangles: rows.reduce((n, r) => n + r.triangles, 0),
    programs: renderer.info.programs?.length ?? 0,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    rows,
    overdraw: {
      issued: issuedAll.mean,
      issuedOpaque: issuedOpaque.mean,
      shaded: shadedAll.mean,
      shadedOpaque: shadedOpaque.mean,
      max: issuedAll.max,
    },
  }
}
