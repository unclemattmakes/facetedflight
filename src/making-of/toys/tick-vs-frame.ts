// T04, tick against frame. DEV-512 (docs/plan/MAKING-OF.md §4).
//
// The game's physics runs at one fixed rate, whatever the screen does. A ball
// moves at constant speed in the REAL fixed-step clock (`stepFixed`); the toy
// then draws it at a display rate you choose, with and without the
// interpolation the renderer uses. The bars are how far the drawn ball moved
// each display frame: a smooth motion is bars of one height.

import { FIXED_DT } from '@/sim/constants'
import { createCanvas2D } from '../shared/canvas2d'
import { createToyClock, type ToyDef } from '../shared/toy-host'

const RATES = [30, 60, 72, 90, 120, 144] as const
const HISTORY = 90
const SPEED = 3 // ball speed in sim units per second; a toy control

export const toy: ToyDef = {
  id: 'tick-vs-frame',
  title: 'Tick against frame',
  caption:
    'Pick a display rate and turn interpolation off. Bars of uneven height are a ball that stutters although it moves at a constant speed.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    const clock = createToyClock()
    let rate: number = 60
    let interpolate = true
    let prev = 0
    let cur = 0
    let virtual = 0
    let lastDrawn = 0
    let have = false
    const steps: number[] = []

    const reset = () => {
      steps.length = 0
      have = false
      virtual = 0
    }

    const advance = (frameSeconds: number) => {
      const alpha = clock.step(frameSeconds, (dt) => {
        prev = cur
        cur += SPEED * dt
      })
      const drawn = interpolate ? prev + (cur - prev) * alpha : cur
      if (have) steps.push(drawn - lastDrawn)
      if (steps.length > HISTORY) steps.shift()
      lastDrawn = drawn
      have = true
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const max = Math.max(1e-9, ...steps)
      const mean = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0
      const base = h * 0.8
      const bw = (w - 40) / HISTORY
      const scale = (h * 0.55) / Math.max(max, mean * 1.5, 1e-9)
      steps.forEach((s, i) => {
        const bh = Math.max(0, s * scale)
        ctx.fillStyle = s < mean * 0.5 ? '#ff7a7a' : '#facf63'
        ctx.fillRect(20 + i * bw, base - bh, Math.max(1, bw - 1), bh)
      })
      ctx.strokeStyle = '#6fb4ff'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(20, base - mean * scale)
      ctx.lineTo(w - 20, base - mean * scale)
      ctx.stroke()
      ctx.setLineDash([])
      // The ball along the bottom.
      const x = 20 + ((lastDrawn * 40) % (w - 40))
      ctx.fillStyle = '#facf63'
      ctx.beginPath()
      ctx.arc(x, h * 0.9, 7, 0, Math.PI * 2)
      ctx.fill()
    }

    const readouts = () => {
      const min = steps.length ? Math.min(...steps) : 0
      const max = steps.length ? Math.max(...steps) : 0
      const ratio = min > 1e-9 ? max / min : Number.POSITIVE_INFINITY
      out.update([
        { label: 'sim', value: `${(1 / FIXED_DT).toFixed(2)} Hz` },
        { label: 'display', value: `${rate} Hz` },
        {
          label: 'step ratio',
          value: Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : 'stalls',
          tone: ratio < 1.05 ? 'good' : 'bad',
        },
      ])
    }

    controls.segmented<string>({
      options: RATES.map((r) => ({ value: String(r), label: `${r} Hz` })),
      value: String(rate),
      onChange: (v) => {
        rate = Number(v)
        reset()
      },
    })
    controls.toggle({
      label: 'interpolate',
      value: interpolate,
      onChange: (v) => {
        interpolate = v
        reset()
      },
    })
    readouts()

    return {
      // A virtual display: whatever the real frame time, advance the sim in
      // whole display frames of 1 / rate, so the pattern is the chosen rate's.
      frame(dt) {
        virtual += dt
        const frame = 1 / rate
        while (virtual >= frame) {
          virtual -= frame
          advance(frame)
        }
        readouts()
        draw()
      },
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
