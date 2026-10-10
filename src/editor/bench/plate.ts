// src/editor/bench/plate.ts — the bench's plate: what the draft is, what is
// wrong with it, and six buttons. DEV-492.
//
// One canvas on one quad at the table's near edge, pressed by a hand's ray and
// the trigger. The cells are a pure function of (u, v) (`benchCellAt`), so what
// the painter draws and what the ray hits are the same rectangle, the argument
// `render/pause.ts`'s `rowTopM` makes. UI, so `toneMapped: false`, which
// `render/bloom.ts` puts on `UI_LAYER` (3): stereo, never layer 1 or 2 (the
// eyes, DEV-141). Nothing picks it with three's raycaster (which sees layer 0
// only, DEV-472): the hit is the plane's own arithmetic.

import * as THREE from 'three'
import { UI_ACCENT, UI_DIM, UI_INK, UI_STACK } from '@/render/ui-tokens'

/** The buttons, left to right. */
export const BENCH_CELLS = ['undo', 'redo', 'delete', 'lift', 'fly', 'leave'] as const
export type BenchCell = (typeof BENCH_CELLS)[number]

const LABEL: Readonly<Record<BenchCell, string>> = {
  undo: 'UNDO',
  redo: 'REDO',
  delete: 'DELETE',
  lift: 'LIFT',
  fly: 'FLY',
  leave: 'LEAVE',
}

/** The plate's aspect, width over height. */
export const PLATE_ASPECT = 3.2
/** The share of the plate's height the button row takes, from the bottom. */
const BUTTON_ROW = 0.46
/** Air between buttons and round the row, as a share of the plate's width. */
const GUTTER = 0.012

/** The cell at plate UV (u right, v UP, both 0..1), or null off every button. */
export const benchCellAt = (u: number, v: number): BenchCell | null => {
  if (!(u >= GUTTER && u <= 1 - GUTTER && v >= GUTTER * PLATE_ASPECT && v <= BUTTON_ROW)) {
    return null
  }
  const w = (1 - GUTTER) / BENCH_CELLS.length
  const i = Math.floor((u - GUTTER / 2) / w)
  const inCell = (u - GUTTER / 2) / w - i
  if (inCell < GUTTER / (2 * w) || inCell > 1 - GUTTER / (2 * w)) return null
  return BENCH_CELLS[Math.min(BENCH_CELLS.length - 1, Math.max(0, i))] ?? null
}

/** A cell's centre, plate UV. The inverse of {@link benchCellAt} for a spec's aim. */
export const benchCellCentre = (cell: BenchCell): { u: number; v: number } => {
  const i = BENCH_CELLS.indexOf(cell)
  const w = (1 - GUTTER) / BENCH_CELLS.length
  return { u: GUTTER / 2 + w * (i + 0.5), v: (GUTTER * PLATE_ASPECT + BUTTON_ROW) / 2 }
}

const MONO = UI_STACK
/** The room's plate inks (`render/course-shelf.ts`), and the HUD's accent. */
const INK = UI_INK
const DIM = UI_DIM
const ACCENT = UI_ACCENT
const WARN = '#ff7a6b'

export interface BenchPlate {
  readonly object: THREE.Mesh
  /** Paint, when anything changed. `enabled` greys a button that would do nothing. */
  paint(
    status: string,
    note: string,
    noteWarns: boolean,
    aimed: BenchCell | null,
    enabled: Readonly<Record<BenchCell, boolean>>,
  ): void
  /** The cell a local-frame ray (plate's parent's frame) lands on, and how far, or null. */
  hit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): { cell: BenchCell | null; distance: number } | null
  /** A cell's centre in the plate's PARENT frame. */
  cellCentre(cell: BenchCell, out: THREE.Vector3): THREE.Vector3
  dispose(): void
}

export const createBenchPlate = (width: number): BenchPlate => {
  const height = width / PLATE_ASPECT
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = Math.round(1024 / PLATE_ASPECT)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
  mesh.name = 'bench-plate'
  let painted = ''

  const _inv = new THREE.Matrix4()
  const _o = new THREE.Vector3()
  const _d = new THREE.Vector3()

  return {
    object: mesh,
    paint(status, note, noteWarns, aimed, enabled) {
      const key = JSON.stringify([status, note, noteWarns, aimed, enabled])
      if (key === painted) return
      painted = key
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(4, 8, 14, 0.86)'
      ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = DIM
      ctx.lineWidth = 3
      ctx.strokeRect(1.5, 1.5, W - 3, H - 3)
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillStyle = INK
      ctx.font = `600 34px ${MONO}`
      ctx.fillText(status, 22, H * 0.14, W - 44)
      ctx.fillStyle = noteWarns ? WARN : DIM
      ctx.font = `500 26px ${MONO}`
      ctx.fillText(note, 22, H * 0.34, W - 44)
      const w = (1 - GUTTER) / BENCH_CELLS.length
      for (const [i, cell] of BENCH_CELLS.entries()) {
        const x0 = (GUTTER / 2 + w * i + GUTTER / 2) * W
        const x1 = (GUTTER / 2 + w * (i + 1) - GUTTER / 2) * W
        const y0 = (1 - BUTTON_ROW) * H
        const y1 = (1 - GUTTER * PLATE_ASPECT) * H
        const on = enabled[cell]
        ctx.fillStyle = aimed === cell && on ? '#6f8a9c' : '#26323c'
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
        ctx.strokeStyle = aimed === cell ? ACCENT : '#4d6272'
        ctx.lineWidth = aimed === cell ? 5 : 2
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
        ctx.textAlign = 'center'
        ctx.fillStyle = on ? (cell === 'fly' ? ACCENT : INK) : '#56646f'
        ctx.font = `700 40px ${MONO}`
        ctx.fillText(LABEL[cell], (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 10)
        ctx.textAlign = 'left'
      }
      texture.needsUpdate = true
    },
    hit(origin, direction) {
      mesh.updateMatrix()
      _inv.copy(mesh.matrix).invert()
      _o.copy(origin).applyMatrix4(_inv)
      _d.copy(origin).add(direction).applyMatrix4(_inv).sub(_o)
      if (Math.abs(_d.z) < 1e-9) return null
      const t = -_o.z / _d.z
      if (!(t > 0)) return null
      const x = _o.x + _d.x * t
      const y = _o.y + _d.y * t
      if (Math.abs(x) > width / 2 || Math.abs(y) > height / 2) return null
      // `t` runs along the parent-frame ray, whose direction is unit: it is metres.
      return { cell: benchCellAt(x / width + 0.5, y / height + 0.5), distance: t }
    },
    cellCentre(cell, out) {
      const c = benchCellCentre(cell)
      mesh.updateMatrix()
      return out.set((c.u - 0.5) * width, (c.v - 0.5) * height, 0).applyMatrix4(mesh.matrix)
    },
    dispose() {
      texture.dispose()
      material.dispose()
      mesh.geometry.dispose()
    },
  }
}
