// T23, the ruler. DEV-519 (docs/plan/MAKING-OF.md §4).
//
// The AI racers follow a line drawn through `int_01_hoverJet`'s gates. A
// tuning constant was once built on "the gates sit up to 24.6 m off the racing
// line", which was the distance to the nearest VERTEX of a polyline whose
// vertices are 27 m apart. The distance to the LINE, which is what matters, is
// a fraction of a metre. The toy measures both for any gate, and lets you thin
// the line's points to watch the wrong ruler grow while the right one holds.
//
// The right ruler is the game's own `routeDistance`. The wrong one is a few
// lines of the toy's own, on purpose: it is the mistake being shown.

import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import { courseGates } from '@/game/mission'
import { createRoute, routeDistance } from '@/sim/route'
import raw from '../../../content/levels/int_01_hoverJet.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

export const toy: ToyDef = {
  id: 'route-ruler',
  title: 'The ruler',
  caption:
    'Pick a gate. The blue distance is to the nearest point of the line, the red one to the nearest corner. Thin the line and the red number grows much faster than the blue.',
  kind: '2d',
  mount({ stage, controls }) {
    const level = validateLevel(raw as unknown as Level)
    const full = (raw as unknown as { route: number[][] }).route
    const gates = courseGates(level)
    const out = controls.readouts()
    const cv = createCanvas2D(stage)
    let gateIndex = 0
    let keepEvery = 1
    let zoomed = true

    const draw = () => {
      const pts = full.filter((_, i) => i % keepEvery === 0 || i === full.length - 1)
      const route = createRoute(pts)
      // createRoute mirrors z into sim space, as the gates are.
      const sim = pts.map((p) => ({ x: p[0] as number, y: p[1] as number, z: -(p[2] as number) }))
      const gate = gates[gateIndex]
      if (!gate) return
      const toLine = routeDistance(route, gate.centre)
      let toVertex = Number.POSITIVE_INFINITY
      for (const p of sim) {
        toVertex = Math.min(
          toVertex,
          Math.hypot(p.x - gate.centre.x, p.y - gate.centre.y, p.z - gate.centre.z),
        )
      }
      const spacing = route.length / Math.max(1, pts.length - 1)

      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const xs = gates.map((g) => g.centre.x)
      const zs = gates.map((g) => g.centre.z)
      // Zoomed: a patch around the gate, wide enough to see its neighbours' corners.
      const around = Math.max(110, toVertex * 1.6)
      const [x0, x1] = zoomed
        ? [gate.centre.x - around, gate.centre.x + around]
        : [Math.min(...xs) - 150, Math.max(...xs) + 150]
      const [z0, z1] = zoomed
        ? [gate.centre.z - around, gate.centre.z + around]
        : [Math.min(...zs) - 150, Math.max(...zs) + 150]
      const s = Math.min(w / (x1 - x0), h / (z1 - z0))
      const px = (x: number) => (w - (x1 - x0) * s) / 2 + (x - x0) * s
      const pz = (z: number) => (h - (z1 - z0) * s) / 2 + (z - z0) * s
      ctx.beginPath()
      sim.forEach((p, i) => {
        if (i === 0) ctx.moveTo(px(p.x), pz(p.z))
        else ctx.lineTo(px(p.x), pz(p.z))
      })
      ctx.strokeStyle = '#98a3bd'
      ctx.lineWidth = 1.5
      ctx.stroke()
      for (const p of sim) {
        ctx.fillStyle = '#66738f'
        ctx.fillRect(px(p.x) - 1.5, pz(p.z) - 1.5, 3, 3)
      }
      gates.forEach((g, i) => {
        ctx.beginPath()
        ctx.arc(px(g.centre.x), pz(g.centre.z), i === gateIndex ? 6 : 3, 0, Math.PI * 2)
        ctx.fillStyle = i === gateIndex ? '#facf63' : '#c2c8e5'
        ctx.fill()
      })
      // The two measurements from the chosen gate, as circles of that radius.
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#ff7a7a'
      ctx.beginPath()
      ctx.arc(px(gate.centre.x), pz(gate.centre.z), toVertex * s, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = '#6fb4ff'
      ctx.beginPath()
      ctx.arc(px(gate.centre.x), pz(gate.centre.z), Math.max(2, toLine * s), 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])

      out.update([
        { label: 'to the line', value: `${toLine.toFixed(1)} m`, tone: 'good' },
        { label: 'to the nearest corner', value: `${toVertex.toFixed(1)} m`, tone: 'bad' },
        { label: 'corner spacing', value: `${spacing.toFixed(0)} m` },
        { label: 'gate radius', value: `${gate.radius.toFixed(1)} m` },
      ])
    }

    controls.slider({
      label: 'gate',
      min: 1,
      max: gates.length,
      step: 1,
      value: 1,
      onInput: (v) => {
        gateIndex = v - 1
        draw()
      },
    })
    controls.slider({
      label: 'thin the line',
      min: 1,
      max: 6,
      step: 1,
      value: keepEvery,
      format: (v) => (v === 1 ? 'as shipped' : `every ${v}th`),
      onInput: (v) => {
        keepEvery = v
        draw()
      },
    })
    controls.toggle({
      label: 'zoom to the gate',
      value: zoomed,
      onChange: (v) => {
        zoomed = v
        draw()
      },
    })
    draw()
    return {
      resize: (w, hh) => {
        cv.resize(w, hh)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
