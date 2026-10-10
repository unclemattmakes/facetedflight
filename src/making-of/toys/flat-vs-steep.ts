// T11, a flat sample, a steep truth. DEV-514 (docs/plan/MAKING-OF.md §4).
//
// The game has two ground surfaces: the one you HIT (`terrainHeightAt`, the map
// on the 8 m grid with no jitter) and the one you SEE (`renderSurfaceHeightAt`,
// the jittered, triangulated mesh). This cuts a section through a seeded island
// and draws both. Where the ground is flat the two agree and a spot check
// there proves nothing; on a steep face they part. The probe reports the gap
// and the slope under it.

import { terrainHeightAt } from '@/sim/terrain/height-field'
import { renderSurfaceHeightAt, renderSurfaceSlopeAt } from '@/sim/terrain/surface'
import { createCanvas2D } from '../shared/canvas2d'
import { loadSimonetTerrain, makeIslandGround } from '../shared/island-ground'
import type { ToyDef } from '../shared/toy-host'

/** A wider window than the facet toy shows: a section needs a shore and a face in it. */
const WINDOW = 2048

export const toy: ToyDef = {
  id: 'flat-vs-steep',
  title: 'Flat and steep',
  caption:
    'The gold line is the surface the mesh draws, the blue one is the surface a ship hits. Slide the probe from flat ground up a steep face and watch the gap open.',
  kind: '2d',
  async mount({ stage, controls }) {
    const shipped = await loadSimonetTerrain()
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    let seed = 7
    let jitter = shipped.randomOffset
    let line = 0.5
    let probe = 0.3
    /** Per-sample slope and height of the section last drawn, for the two find buttons. */
    let slopes: number[] = []
    let heights: number[] = []

    const draw = () => {
      const g = makeIslandGround({
        seed,
        rugged: 0.5,
        randomOffset: jitter,
        baseResolution: shipped.baseResolution,
        faithfulDiagonalBug: true,
        tile: WINDOW,
      })
      const z = line * WINDOW
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const px = (x: number) => 20 + (x / WINDOW) * (w - 40)
      const samples = 256
      const seen: number[] = []
      const hit: number[] = []
      slopes = []
      heights = []
      let top = 1
      for (let i = 0; i <= samples; i++) {
        const x = (i / samples) * WINDOW
        seen.push(renderSurfaceHeightAt(g.grid, g.heightMap, g.params, x, z))
        hit.push(terrainHeightAt(g.field, x, z))
        slopes.push(renderSurfaceSlopeAt(g.grid, g.heightMap, g.params, x, z))
        heights.push(seen[i] as number)
        top = Math.max(top, seen[i] as number, hit[i] as number)
      }
      const py = (y: number) => h - 24 - (y / top) * (h - 60)
      const path = (ys: readonly number[]) => {
        ctx.beginPath()
        ys.forEach((y, i) => {
          const X = px((i / samples) * WINDOW)
          if (i === 0) ctx.moveTo(X, py(y))
          else ctx.lineTo(X, py(y))
        })
      }
      path(hit)
      ctx.strokeStyle = '#6fb4ff'
      ctx.lineWidth = 2
      ctx.stroke()
      path(seen)
      ctx.strokeStyle = '#facf63'
      ctx.lineWidth = 1.5
      ctx.stroke()
      const x = probe * WINDOW
      const sx = px(x)
      const sy = renderSurfaceHeightAt(g.grid, g.heightMap, g.params, x, z)
      const hy = terrainHeightAt(g.field, x, z)
      ctx.strokeStyle = 'rgba(194,200,229,0.4)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sx, 10)
      ctx.lineTo(sx, h - 10)
      ctx.stroke()
      ctx.fillStyle = '#facf63'
      ctx.beginPath()
      ctx.arc(sx, py(sy), 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#6fb4ff'
      ctx.beginPath()
      ctx.arc(sx, py(hy), 4, 0, Math.PI * 2)
      ctx.fill()
      let worst = 0
      let sum = 0
      for (let i = 0; i <= samples; i++) {
        const d = Math.abs((seen[i] as number) - (hit[i] as number))
        worst = Math.max(worst, d)
        sum += d
      }
      const gap = Math.abs(sy - hy)
      const slope = renderSurfaceSlopeAt(g.grid, g.heightMap, g.params, x, z)
      out.update([
        { label: 'gap here', value: `${gap.toFixed(2)} m`, tone: gap < 0.3 ? 'good' : 'bad' },
        { label: 'slope here', value: slope.toFixed(2) },
        { label: 'worst on the section', value: `${worst.toFixed(1)} m` },
        { label: 'mean on the section', value: `${(sum / (samples + 1)).toFixed(2)} m` },
      ])
    }

    const probeSlider = controls.slider({
      label: 'probe',
      min: 0,
      max: 1,
      step: 0.005,
      value: probe,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      onInput: (v) => {
        probe = v
        draw()
      },
    })
    controls.slider({
      label: 'section',
      min: 0.05,
      max: 0.95,
      step: 0.01,
      value: line,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      onInput: (v) => {
        line = v
        draw()
      },
    })
    controls.slider({
      label: 'jitter',
      min: 0,
      max: 3,
      step: 0.1,
      value: jitter,
      format: (v) => `${v.toFixed(1)} m`,
      onInput: (v) => {
        jitter = v
        draw()
      },
    })
    /** Move the probe to the dry sample that wins the comparison. */
    const find = (better: (a: number, b: number) => boolean) => {
      let at = -1
      slopes.forEach((sl, i) => {
        if ((heights[i] as number) < 5) return
        if (at < 0 || better(sl, slopes[at] as number)) at = i
      })
      if (at >= 0) {
        probe = at / (slopes.length - 1)
        probeSlider.set(probe)
      }
      draw()
    }
    controls.button('steepest', () => find((a, b) => a > b))
    controls.button('flattest', () => find((a, b) => a < b))
    controls.button('new island', () => {
      seed += 1
      draw()
    })
    draw()
    return {
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
