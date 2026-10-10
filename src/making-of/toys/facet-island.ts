// T09, the facet island. DEV-514 (docs/plan/MAKING-OF.md §4).
//
// A small seeded island, triangulated by the game's own terrain functions:
// `buildVertexGrid` jitters the grid, and `diagonalTopLeftToBottomRight` picks
// each quad's split. That function carries the 2016 bug on purpose (it samples
// the height map at a V built from the midpoint's HEIGHT, not its z), and the
// toy shows what the bug does: switch "show flipped quads" on and the quads
// the correct rule would have split the other way are outlined.

import { diagonalTopLeftToBottomRight, type FacetedTerrainParams } from '@/sim/terrain/faceted'
import { createCanvas2D } from '../shared/canvas2d'
import { loadSimonetTerrain, makeIslandGround, TILE } from '../shared/island-ground'
import type { ToyDef } from '../shared/toy-host'

const LIGHT = [-0.45, 0.8, -0.35] as const

export const toy: ToyDef = {
  id: 'facet-island',
  title: 'Facet island',
  caption:
    'Every quad is split into two triangles, and which way is decided by a function with a bug the 2016 game shipped with. Show the flipped quads, then turn the bug off and watch them change.',
  kind: '2d',
  async mount({ stage, controls }) {
    const shipped = await loadSimonetTerrain()
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    let seed = 7
    let rugged = 0.55
    let jitter = shipped.randomOffset
    let faithful = true
    let showFlips = false

    const draw = () => {
      const g = makeIslandGround({
        seed,
        rugged,
        randomOffset: jitter,
        baseResolution: shipped.baseResolution,
        faithfulDiagonalBug: faithful,
      })
      const correct: FacetedTerrainParams = { ...g.params, faithfulDiagonalBug: false }
      const { verts, vertPerSide: n } = g.grid
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const s = Math.min(w, h) / (TILE * 1.04)
      const ox = (w - TILE * s) / 2
      const oy = (h - TILE * s) / 2
      const px = (i: number) => ox + (verts[i] as number) * s
      const pz = (i: number) => oy + (verts[i + 2] as number) * s
      const at = (xi: number, zi: number) => (xi * n + zi) * 3
      const cx = [0, 0, 0, 0]
      const cy = [0, 0, 0, 0]
      const cz = [0, 0, 0, 0]
      let flipped = 0
      const shade = (a: number, b: number, c: number) => {
        const ux = (verts[b] as number) - (verts[a] as number)
        const uy = (verts[b + 1] as number) - (verts[a + 1] as number)
        const uz = (verts[b + 2] as number) - (verts[a + 2] as number)
        const vx = (verts[c] as number) - (verts[a] as number)
        const vy = (verts[c + 1] as number) - (verts[a + 1] as number)
        const vz = (verts[c + 2] as number) - (verts[a + 2] as number)
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const len = Math.hypot(nx, ny, nz) || 1
        if (ny < 0) {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        const lit = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / len)
        const height =
          ((verts[a + 1] as number) + (verts[b + 1] as number) + (verts[c + 1] as number)) / 3
        const sea = height < 2
        const [red, grn, blu] = sea ? [40, 70, 120] : [90 + height * 0.5, 130 + height * 0.2, 90]
        const k = 0.45 + lit * 0.7
        const ch = (v: number | undefined) => Math.min(255, (v ?? 0) * k) | 0
        return `rgb(${ch(red)},${ch(grn)},${ch(blu)})`
      }
      const tri = (a: number, b: number, c: number) => {
        ctx.beginPath()
        ctx.moveTo(px(a), pz(a))
        ctx.lineTo(px(b), pz(b))
        ctx.lineTo(px(c), pz(c))
        ctx.closePath()
        ctx.fillStyle = shade(a, b, c)
        ctx.fill()
      }
      for (let xi = 0; xi < n - 1; xi++) {
        for (let zi = 0; zi < n - 1; zi++) {
          // Corners 0 = (x0,z0), 1 = (x0,z1), 2 = (x1,z0), 3 = (x1,z1), as the game's function wants.
          const idx = [at(xi, zi), at(xi, zi + 1), at(xi + 1, zi), at(xi + 1, zi + 1)] as const
          for (let k = 0; k < 4; k++) {
            cx[k] = verts[idx[k] as number] as number
            cy[k] = verts[(idx[k] as number) + 1] as number
            cz[k] = verts[(idx[k] as number) + 2] as number
          }
          const split = diagonalTopLeftToBottomRight(cx, cy, cz, g.heightMap, g.params)
          const right = diagonalTopLeftToBottomRight(cx, cy, cz, g.heightMap, correct)
          const [i0, i1, i2, i3] = idx
          if (split) {
            tri(i0, i1, i2)
            tri(i2, i1, i3)
          } else {
            tri(i0, i1, i3)
            tri(i0, i3, i2)
          }
          if (split !== right) {
            flipped++
            if (showFlips) {
              ctx.strokeStyle = '#facf63'
              ctx.lineWidth = 1.5
              ctx.strokeRect(px(i0), pz(i0), (px(i3) - px(i0)) | 0 || 1, (pz(i3) - pz(i0)) | 0 || 1)
            }
          }
        }
      }
      const quads = (n - 1) * (n - 1)
      out.update([
        { label: 'quads', value: String(quads) },
        {
          label: 'split the other way than the intended rule',
          value: `${flipped} (${((flipped / quads) * 100).toFixed(0)}%)`,
          tone: faithful ? 'bad' : 'good',
        },
        { label: 'jitter', value: `${jitter.toFixed(1)} m` },
      ])
    }

    controls.slider({
      label: 'ruggedness',
      min: 0,
      max: 1,
      step: 0.05,
      value: rugged,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        rugged = v
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
    controls.toggle({
      label: '2016 diagonal bug',
      value: faithful,
      onChange: (v) => {
        faithful = v
        draw()
      },
    })
    controls.toggle({
      label: 'show flipped quads',
      value: showFlips,
      onChange: (v) => {
        showFlips = v
        draw()
      },
    })
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
