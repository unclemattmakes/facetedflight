// src/editor/desk/island-dialog.ts — "New island…": a heightmap in, a preview
// on a diorama, and the editor over it. DEV-490 (T1.5).
//
// docs/plan/EDITOR.md §5.4: the creator brings a greyscale map, sets its world
// size and maximum height, sees it, and lays a course on it. DEV-489 measured
// the cost that shapes this: the ground is ~0.5 s and the world's two bakes
// ~2.3 s at 4 km, so the dialog PREVIEWS on a diorama — the hangar's own
// miniature (`render/diorama.ts`), on a small canvas of its own — and the world
// is built once, when the island is used.
//
// The preview is the map as the course will read it, rebased so the diorama's
// own sea (its field's origin) is the waterline: `sea` grey at 0, white at the
// height. The world build goes through `mapGround`, which puts the same
// waterline where the island's sea really stands.
//
// DOM, and a second WebGL context the size of the canvas; disposed on close.

import * as THREE from 'three'
import {
  decodeHeightmap,
  HEIGHTMAP_LIMITS,
  type Heightmap,
  heightmapSha,
  heightmapTooLarge,
} from '@/content/island-map'
import {
  groundKey,
  islandChunkMetres,
  islandHeightScale,
  islandPeakHeight,
  islandWaterline,
  PLAYER_COURSE_ISLAND,
  type PlayerCourseGround,
  type PlayerCourseMapIsland,
  type PlayerCourseSeedIsland,
} from '@/content/player-course'
import { make } from '@/editor/ui/dom'
import { type CustomGround, mapGround, seedGround } from '@/game/terrain/custom-ground'
import { createDiorama, type Diorama } from '@/render/diorama'
import { buildHeightField } from '@/sim/terrain/height-field'
import { createGreySampler, type GreyDataF32 } from '@/sim/terrain/image-sampler'
import {
  ISLAND_SYNTH,
  ISLAND_SYNTH_VERSION,
  type IslandShape,
  type IslandSynthVersion,
  synthesiseIsland,
} from '@/sim/terrain/island-synth'

/**
 * The dialog's defaults and its one sentence of rights. Policy; pinned in
 * `tests/unit/island-map.test.ts`.
 */
export const ISLAND_DIALOG = {
  // DEV-499: no default HEIGHT here. It is the island's own scale above its
  // waterline, read from the sheet (`islandDialogHeight`), so it cannot be typed.
  /** The waterline grey, percent: black a little under the sea, so a flat black is a sea floor. */
  defaultSeaPercent: 5,
  /** EDITOR.md §5.4's "one sentence in the import dialog". */
  rights:
    'Import only a map you have the rights to use: your own terrain tool’s export, or a public-domain elevation model such as USGS or SRTM.',
  /** DEV-493: a new seeded island's two shape sliders, 0..1. */
  defaultRugged: 0.5,
  defaultSea: 0.45,
  /** DEV-493: the reroll preview's grid: one sample of the SAME function every 32 m at 4 km. */
  previewEdge: 129,
  /** The preview canvas, CSS pixels. */
  previewWidth: 360,
  previewHeight: 220,
} as const

/** What "Use this island" hands the desk. */
export interface IslandChoice {
  /** The course's island block (the format's `island: { map, … }` or, DEV-493, `{ seed, … }`). */
  readonly island: PlayerCourseGround
  /** The world's ground, built once, keyed to that block. */
  readonly ground: CustomGround
  /** The map file's bytes, for the library and the `.ffcourse`; null for a seeded island. */
  readonly bytes: Uint8Array | null
}

export interface IslandDialogOptions {
  /** The island whose colours, props and sea the new one wears: the sky's. */
  readonly island: string
  /** Its own land's side, metres: the size a new island starts at. */
  readonly defaultSize: number
  use(choice: IslandChoice): void
  close(): void
}

export interface IslandDialog {
  readonly element: HTMLElement
  close(): void
}

/**
 * DEV-499: the "highest point above the sea" field of both dialogs for
 * `island`: from `PLAYER_COURSE_ISLAND.minHeight` to the island's own height
 * scale (`islandHeightScale`, the sheet's `terrainHeight` less its waterline),
 * starting at the island's measured summit (`islandPeakHeight`, DEV-534; the
 * scale where there is no measurement). Matt: *"does the max height match the
 * max height of 2016's maps?"* It does now, island by island; and *"measured
 * peak"*: Simonet starts at 892 m, not its full white's 1,337.
 */
export const islandDialogHeight = (
  island: string,
): { readonly min: number; readonly max: number; readonly value: number } => {
  const I = PLAYER_COURSE_ISLAND
  // The sheet's tallest land is the validator's ceiling, so a scale is always under it.
  const max = islandHeightScale(island) ?? Math.floor(I.maxTerrainHeight - islandWaterline(island))
  const peak = islandPeakHeight(island) ?? max
  return { min: I.minHeight, max, value: Math.max(I.minHeight, Math.min(max, peak)) }
}

/** The heights the preview draws: `sea` grey at 0, white at 1. */
export const previewHeights = (map: Heightmap, sea: number): GreyDataF32 => {
  const data = new Float32Array(map.data.length)
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.min(1, Math.max(0, ((map.data[i] as number) - sea) / (1 - sea)))
  }
  return { width: map.width, height: map.height, data }
}

/** A diorama on a canvas of its own, turning slowly. */
const createPreview = (canvas: HTMLCanvasElement) => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1))
  renderer.setSize(ISLAND_DIALOG.previewWidth, ISLAND_DIALOG.previewHeight, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(
    32,
    ISLAND_DIALOG.previewWidth / ISLAND_DIALOG.previewHeight,
    0.01,
    10,
  )
  camera.position.set(0, 0.42, 0.78)
  camera.lookAt(0, 0.02, 0)
  const turntable = new THREE.Group()
  scene.add(turntable)
  let diorama: Diorama | null = null
  let raf = 0
  let last = performance.now()
  const draw = (): void => {
    const now = performance.now()
    turntable.rotation.y += ((now - last) / 1000) * 0.25
    last = now
    renderer.render(scene, camera)
    raf = requestAnimationFrame(draw)
  }
  raf = requestAnimationFrame(draw)
  return {
    /** Show `heights` as an island `size` metres across and `height` tall. */
    show(heights: GreyDataF32, size: number, height: number): void {
      const field = buildHeightField(
        createGreySampler(heights),
        {
          terrainSize: size,
          terrainHeight: height,
          chunkSize: size,
          // Coarse on purpose: the diorama draws a 56-cell grid.
          baseResolution: size / 128,
          randomOffset: 0,
          seed: 0,
        },
        { position: [0, 0, 0], scale: [1, 1, 1] },
      )
      if (diorama) {
        turntable.remove(diorama.object)
        diorama.dispose()
      }
      diorama = createDiorama({ field, route: null, size: 0.6 })
      turntable.add(diorama.object)
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      diorama?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}

const STYLE = `
#island-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:8;width:400px;
  max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;box-sizing:border-box;
  display:flex;flex-direction:column;gap:10px;padding:16px;background:rgba(10,16,24,.95);color:#e8f0f8;
  border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
#island-dialog h2{margin:0;font-size:12px;letter-spacing:.18em;color:#7fd3ff;font-weight:600}
#island-dialog .row{display:flex;align-items:center;gap:8px}
#island-dialog .row>label{flex:1;color:#b8c6d4}
#island-dialog input[type=number],#island-dialog select{width:110px;background:#0c1520;color:#e8f0f8;
  border:1px solid #33475c;border-radius:5px;padding:4px 6px;font:inherit}
#island-dialog canvas{width:${ISLAND_DIALOG.previewWidth}px;height:${ISLAND_DIALOG.previewHeight}px;
  max-width:100%;align-self:center;background:#060b11;border-radius:8px}
#island-dialog .note{color:#9fb0c0;font-size:12px}
#island-dialog .rights{color:#7d8ea0;font-size:11px}
#island-dialog .error{color:#ff7a7a;font-size:12px}
#island-dialog .error:empty{display:none}
#island-dialog .buttons{display:flex;gap:6px;justify-content:flex-end}
#island-dialog button{background:#1c2b3b;color:#e8f0f8;border:1px solid #3a5670;border-radius:6px;
  padding:6px 10px;font:inherit;cursor:pointer}
#island-dialog button:disabled{opacity:.45;cursor:default}
#island-dialog button.primary{background:#1f7a4d;border-color:#2fa56a;font-weight:600}
`

/** "New island from a heightmap…": open it over the editor. */
export const openIslandDialog = (opts: IslandDialogOptions): IslandDialog => {
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
  const el = make('div', { id: 'island-dialog' })
  el.dataset.state = 'empty'
  // Typing in a field is not an editor key.
  el.addEventListener('keydown', (e) => e.stopPropagation())
  el.addEventListener('keyup', (e) => e.stopPropagation())

  const I = PLAYER_COURSE_ISLAND
  const chunk = islandChunkMetres(opts.island) ?? 256
  const water = islandWaterline(opts.island)
  const heights = islandDialogHeight(opts.island) // DEV-499
  const maxHeight = heights.max

  const file = make('input', { type: 'file', accept: '.png,.r16,.raw' })
  file.dataset.editor = 'island-file'
  const sizeSelect = make('select')
  sizeSelect.dataset.editor = 'island-size'
  for (let s = chunk * 4; s <= I.maxSize; s *= 2) {
    sizeSelect.append(make('option', { value: String(s), textContent: `${s / 1000} km` }))
  }
  sizeSelect.value = String(
    Math.min(I.maxSize, Math.max(chunk * 4, opts.defaultSize - (opts.defaultSize % chunk))),
  )
  if (sizeSelect.value === '') sizeSelect.selectedIndex = 0
  const heightIn = make('input', {
    type: 'number',
    min: String(I.minHeight),
    max: String(maxHeight),
    step: '10',
    value: String(heights.value),
  })
  heightIn.dataset.editor = 'island-height'
  const seaIn = make('input', {
    type: 'number',
    min: '0',
    max: String(Math.round(I.seaMax * 100)),
    step: '1',
    value: String(ISLAND_DIALOG.defaultSeaPercent),
  })
  seaIn.dataset.editor = 'island-sea'
  const canvas = make('canvas')
  const note = make('div', {
    className: 'note',
    textContent: 'Choose a greyscale PNG (8 or 16 bits) or a square .r16.',
  })
  const error = make('div', { className: 'error' })
  const use = make('button', {
    type: 'button',
    className: 'primary',
    textContent: 'Use this island',
    disabled: true,
  })
  use.dataset.editor = 'island-use'
  const cancel = make('button', { type: 'button', textContent: 'Cancel' })
  cancel.dataset.editor = 'island-cancel'

  el.append(
    make('h2', { textContent: 'NEW ISLAND FROM A HEIGHTMAP' }),
    file,
    make('div', { className: 'rights', textContent: ISLAND_DIALOG.rights }),
    make('div', { className: 'row' }, make('label', { textContent: 'World size' }), sizeSelect),
    make(
      'div',
      { className: 'row', title: 'Metres from the sea to the map’s white.' },
      make('label', { textContent: 'Highest point above the sea (m)' }),
      heightIn,
    ),
    make(
      'div',
      {
        className: 'row',
        title:
          water > 0
            ? 'The map’s grey that meets the sea. Darker ground is under water.'
            : 'This island has no sea: the map’s grey that is the valley floor.',
      },
      make('label', { textContent: water > 0 ? 'Waterline, % grey' : 'Valley floor, % grey' }),
      seaIn,
    ),
    canvas,
    note,
    error,
    make('div', { className: 'buttons' }, cancel, use),
  )
  document.body.appendChild(el)
  const preview = createPreview(canvas)

  let map: Heightmap | null = null
  let bytes: Uint8Array | null = null
  let sha = ''
  const numbers = () => {
    const size = Number(sizeSelect.value)
    const height = Math.min(
      maxHeight,
      Math.max(I.minHeight, Math.round(Number(heightIn.value) || 0)),
    )
    const sea = Math.min(I.seaMax, Math.max(0, (Number(seaIn.value) || 0) / 100))
    return { size, height, sea: Math.round(sea * 1000) / 1000 }
  }
  const redraw = (): void => {
    if (!map) return
    const n = numbers()
    preview.show(previewHeights(map, n.sea), n.size, n.height)
    el.dataset.preview = `${n.size}:${n.height}:${n.sea}`
  }
  const refuse = (why: string): void => {
    map = null
    bytes = null
    use.disabled = true
    error.textContent = `That map ${why}.`
    el.dataset.state = 'refused'
  }
  file.addEventListener('change', () => {
    const f = file.files?.[0]
    if (!f) return
    error.textContent = ''
    // Asked of the File BEFORE a byte is read.
    if (heightmapTooLarge(f.size)) {
      refuse(`is larger than ${HEIGHTMAP_LIMITS.maxFileBytes / (1024 * 1024)} MB`)
      return
    }
    el.dataset.state = 'reading'
    note.textContent = `Reading ${f.name}…`
    void (async () => {
      const read = new Uint8Array(await f.arrayBuffer())
      const decoded = await decodeHeightmap(read)
      if (!decoded.ok) {
        refuse(decoded.error)
        note.textContent = ''
        return
      }
      map = decoded.map
      bytes = read
      sha = await heightmapSha(read)
      note.textContent = `${decoded.map.width} × ${decoded.map.height}, ${decoded.map.bits}-bit ${decoded.map.format.toUpperCase()}`
      el.dataset.map = `${decoded.map.width}x${decoded.map.height}`
      el.dataset.bits = String(decoded.map.bits)
      use.disabled = false
      el.dataset.state = 'ready'
      redraw()
    })().catch((err: unknown) => {
      console.warn('editor: the heightmap could not be read', err)
      refuse('could not be read')
    })
  })
  for (const input of [sizeSelect, heightIn, seaIn]) input.addEventListener('change', redraw)

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    preview.dispose()
    el.remove()
    style.remove()
    opts.close()
  }
  cancel.addEventListener('click', close)
  use.addEventListener('click', () => {
    if (!map || !bytes) return
    const n = numbers()
    const island: PlayerCourseMapIsland = { map: sha, size: n.size, height: n.height, sea: n.sea }
    let ground: CustomGround
    try {
      ground = mapGround(map, opts.island, island, groundKey(island))
    } catch (err: unknown) {
      refuse(err instanceof Error ? err.message : 'could not be built')
      return
    }
    const choice: IslandChoice = { island, ground, bytes }
    close()
    opts.use(choice)
  })
  return { element: el, close }
}

// ── DEV-493: "New island from a seed" ───────────────────────────────────────

/** The preview of a seeded island: its elevation above the waterline, 0..1. */
export const seedPreviewHeights = (
  seed: number,
  shape: IslandShape,
  version: IslandSynthVersion,
): GreyDataF32 => {
  const n = ISLAND_DIALOG.previewEdge
  const e = synthesiseIsland(seed, shape, n, version)
  const data = new Float32Array(e.length)
  for (let i = 0; i < e.length; i++) data[i] = Math.max(0, e[i] as number)
  return { width: n, height: n, data }
}

export interface SeedDialogOptions extends IslandDialogOptions {
  /** A source of uniform integers in [0, n): the reroll. Injected; the sim never rolls. */
  randomInt(n: number): number
}

/**
 * "New island from a seed": a seed, Reroll, four sliders and a diorama.
 * A reroll or a slider re-synthesises the PREVIEW grid only (`previewEdge`,
 * a few ms) and redraws the diorama; "Use this island" synthesises the
 * world's grid once and hands it over (DEV-489's measured cost: the world's
 * build and bakes are seconds, so they happen once).
 */
export const openSeedDialog = (opts: SeedDialogOptions): IslandDialog => {
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.appendChild(style)
  const el = make('div', { id: 'island-dialog' })
  el.dataset.mode = 'seed'
  el.addEventListener('keydown', (e) => e.stopPropagation())
  el.addEventListener('keyup', (e) => e.stopPropagation())

  const I = PLAYER_COURSE_ISLAND
  const chunk = islandChunkMetres(opts.island) ?? 256
  const water = islandWaterline(opts.island)
  const heights = islandDialogHeight(opts.island) // DEV-499
  const maxHeight = heights.max

  const seedIn = make('input', {
    type: 'number',
    min: '0',
    max: String(ISLAND_SYNTH.seedMax),
    step: '1',
    value: String(opts.randomInt(ISLAND_SYNTH.seedMax + 1)),
  })
  seedIn.dataset.editor = 'island-seed-number'
  const reroll = make('button', { type: 'button', textContent: 'Reroll' })
  reroll.dataset.editor = 'island-reroll'
  const sizeSelect = make('select')
  sizeSelect.dataset.editor = 'island-size'
  for (let v = chunk * 4; v <= I.maxSize; v *= 2) {
    sizeSelect.append(make('option', { value: String(v), textContent: `${v / 1000} km` }))
  }
  sizeSelect.value = String(
    Math.min(I.maxSize, Math.max(chunk * 4, opts.defaultSize - (opts.defaultSize % chunk))),
  )
  if (sizeSelect.value === '') sizeSelect.selectedIndex = 0
  const heightIn = make('input', {
    type: 'number',
    min: String(I.minHeight),
    max: String(maxHeight),
    step: '10',
    value: String(heights.value),
  })
  heightIn.dataset.editor = 'island-height'
  const slider = (name: string, value: number): HTMLInputElement => {
    const r = make('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: String(value),
    })
    r.dataset.editor = name
    return r
  }
  const ruggedIn = slider('island-rugged', ISLAND_DIALOG.defaultRugged)
  const seaIn = slider('island-sea', ISLAND_DIALOG.defaultSea)
  const canvas = make('canvas')
  const note = make('div', { className: 'note' })
  const use = make('button', {
    type: 'button',
    className: 'primary',
    textContent: 'Use this island',
  })
  use.dataset.editor = 'island-use'
  const cancel = make('button', { type: 'button', textContent: 'Cancel' })
  cancel.dataset.editor = 'island-cancel'
  const row = (label: string, control: HTMLElement, title = ''): HTMLElement =>
    make('div', { className: 'row', title }, make('label', { textContent: label }), control)

  el.append(
    make('h2', { textContent: 'NEW ISLAND FROM A SEED' }),
    make('div', { className: 'row' }, make('label', { textContent: 'Seed' }), seedIn, reroll),
    row('World size', sizeSelect),
    row('Highest point above the sea (m)', heightIn),
    row('Rugged', ruggedIn, 'Smooth downs at the left, knife ridges and spires at the right.'),
    row(
      water > 0 ? 'How much sea' : 'How much valley floor',
      seaIn,
      'A broad island at the left, a small one in open water at the right.',
    ),
    canvas,
    note,
    make('div', { className: 'buttons' }, cancel, use),
  )
  document.body.appendChild(el)
  const preview = createPreview(canvas)

  const chosen = (): PlayerCourseSeedIsland => {
    const seed = Math.min(ISLAND_SYNTH.seedMax, Math.max(0, Math.floor(Number(seedIn.value) || 0)))
    const clamp01 = (v: string): number =>
      Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100) / 100
    return {
      // DEV-499: a new island is made with the current generator, and says so.
      v: ISLAND_SYNTH_VERSION,
      seed,
      shape: {
        size: Number(sizeSelect.value),
        height: Math.min(maxHeight, Math.max(I.minHeight, Math.round(Number(heightIn.value) || 0))),
        rugged: clamp01(ruggedIn.value),
        sea: clamp01(seaIn.value),
      },
    }
  }
  const redraw = (): void => {
    const t0 = performance.now()
    const c = chosen()
    preview.show(
      seedPreviewHeights(c.seed, c.shape, ISLAND_SYNTH_VERSION),
      c.shape.size,
      c.shape.height,
    )
    const ms = performance.now() - t0
    el.dataset.version = String(ISLAND_SYNTH_VERSION)
    el.dataset.preview = `${c.seed}:${c.shape.size}:${c.shape.height}:${c.shape.rugged}:${c.shape.sea}`
    el.dataset.previewMs = ms.toFixed(1)
    note.textContent = `Seed ${c.seed} · previewed in ${Math.round(ms)} ms`
  }
  reroll.addEventListener('click', () => {
    seedIn.value = String(opts.randomInt(ISLAND_SYNTH.seedMax + 1))
    redraw()
  })
  for (const input of [seedIn, sizeSelect, heightIn]) input.addEventListener('change', redraw)
  for (const input of [ruggedIn, seaIn]) input.addEventListener('input', redraw)

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    preview.dispose()
    el.remove()
    style.remove()
    opts.close()
  }
  cancel.addEventListener('click', close)
  use.addEventListener('click', () => {
    const island = chosen()
    let ground: CustomGround
    try {
      ground = seedGround(
        island.seed,
        island.shape,
        opts.island,
        groundKey(island),
        ISLAND_SYNTH_VERSION,
      )
    } catch (err: unknown) {
      note.textContent = err instanceof Error ? err.message : 'could not be built'
      return
    }
    close()
    opts.use({ island, ground, bytes: null })
  })
  redraw()
  el.dataset.state = 'ready'
  return { element: el, close }
}
