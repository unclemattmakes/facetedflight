// src/making-of/shared/canvas2d.ts: a 2D canvas that fills a toy's stage, at a
// device pixel ratio capped at 2. DEV-507. Half the best toys are top-down 2D
// (docs/plan/MAKING-OF.md §2.2), and a 2D toy holds no WebGL context.

export interface Canvas2D {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  /** CSS pixels. */
  width: number
  height: number
  resize(width: number, height: number): void
  dispose(): void
}

export const createCanvas2D = (stage: HTMLElement): Canvas2D => {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('making-of: no 2D canvas context')
  stage.append(canvas)
  const out: Canvas2D = {
    canvas,
    ctx,
    width: 0,
    height: 0,
    resize(width, height) {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      out.width = Math.max(1, Math.round(width))
      out.height = Math.max(1, Math.round(height))
      canvas.width = Math.round(out.width * dpr)
      canvas.height = Math.round(out.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    },
    dispose() {
      canvas.remove()
    },
  }
  const r = stage.getBoundingClientRect()
  out.resize(r.width, r.height)
  return out
}
