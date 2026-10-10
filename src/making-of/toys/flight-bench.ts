// T05, the flight bench. DEV-513 (docs/plan/MAKING-OF.md §4).
//
// The game's real HoverJet, flown in open air on the game's real fixed clock.
// The top trace is its speed, the dashed line is where the model says it should
// settle (the fixed-step integrator's own fixed point, off the sheet's thrust,
// mass and drag), the lower trace is its height. Try the three things the
// chapter is about: gravity (the jet flies with it OFF, switched off when the
// launch finishes), boost (free in the shipped game), and the speed chain
// (every gate adds to the ceiling and it falls back after a few seconds).

import { HOVERJET } from '@/generated/constants.generated'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import { chainedMaxSpeed, chainGate, tickTerminalSpeed } from '@/sim/speed-chain'
import { createCanvas2D } from '../shared/canvas2d'
import { createToyClock, type ToyDef } from '../shared/toy-host'

const SECONDS = 24
const SAMPLES_PER_SECOND = 20

export const toy: ToyDef = {
  id: 'flight-bench',
  title: 'Flight bench',
  caption:
    'Watch the speed settle where the model says it will. Turn boost on, chain a few gates, or untick launched and watch it fall.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    const clock = createToyClock()
    let jet = createHoverJet()
    const input = noInput()
    input.throttle = 1
    let launched = true
    let boost = false
    let t = 0
    let sample = 0
    const speeds: number[] = []
    const predicted: number[] = []
    const heights: number[] = []
    const startY = jet.body.position.y

    const reset = () => {
      jet = createHoverJet()
      jet.launched = launched
      t = 0
      sample = 0
      speeds.length = 0
      predicted.length = 0
      heights.length = 0
    }
    reset()

    const model = (): number => {
      const thrust =
        chainedMaxSpeed(jet.chain, jet.chainSpec, HOVERJET.ship.maxSpeed) *
        input.throttle *
        (boost ? jet.tuning.boostMultiplier : 1)
      return tickTerminalSpeed(thrust, HOVERJET.rigidbody.mass, HOVERJET.rigidbody.drag)
    }

    const tick = (dt: number) => {
      input.boost = boost
      stepHoverJet(jet, input, dt)
      t += dt
      if (t * SAMPLES_PER_SECOND >= sample) {
        sample += 1
        const v = jet.body.velocity
        speeds.push(Math.hypot(v.x, v.y, v.z))
        predicted.push(jet.launched ? model() : 0)
        heights.push(jet.body.position.y - startY)
        if (speeds.length > SECONDS * SAMPLES_PER_SECOND) {
          speeds.shift()
          predicted.shift()
          heights.shift()
        }
      }
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const left = 44
      const plotW = w - left - 14
      const topH = h * 0.58
      const maxV = Math.max(40, ...speeds, ...predicted) * 1.1
      const px = (i: number) => left + (i / (SECONDS * SAMPLES_PER_SECOND)) * plotW
      const line = (ys: readonly number[], y0: number, hh: number, max: number, min = 0) => {
        ctx.beginPath()
        ys.forEach((y, i) => {
          const Y = y0 + hh - ((y - min) / (max - min)) * hh
          if (i === 0) ctx.moveTo(px(i), Y)
          else ctx.lineTo(px(i), Y)
        })
      }
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.fillStyle = '#66738f'
      ctx.textAlign = 'left'
      ctx.fillText(`${maxV.toFixed(0)}`, 4, 16)
      ctx.fillText('m/s', 4, topH + 4)
      ctx.setLineDash([5, 4])
      line(predicted, 10, topH - 10, maxV)
      ctx.strokeStyle = '#6fb4ff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
      line(speeds, 10, topH - 10, maxV)
      ctx.strokeStyle = '#facf63'
      ctx.lineWidth = 2
      ctx.stroke()
      // Height, relative to where the jet began.
      const lo = Math.min(-5, ...heights)
      const hi = Math.max(5, ...heights)
      const y0 = topH + 24
      const hh = h - y0 - 12
      ctx.fillStyle = '#66738f'
      ctx.fillText('height', 4, y0 + 10)
      line(heights, y0, hh, hi, lo)
      ctx.strokeStyle = '#7ee0a4'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.lineWidth = 1
    }

    const readouts = () => {
      const v = jet.body.velocity
      const speed = Math.hypot(v.x, v.y, v.z)
      out.update([
        { label: 'speed', value: `${speed.toFixed(1)} m/s` },
        { label: 'model settles at', value: `${model().toFixed(1)} m/s` },
        { label: 'chain', value: String(jet.chain.stacks) },
        {
          label: 'gravity',
          value: jet.launched ? 'off (launched)' : 'on (not launched)',
          tone: jet.launched ? 'good' : 'bad',
        },
      ])
    }

    controls.slider({
      label: 'throttle',
      min: 0,
      max: 1,
      step: 0.05,
      value: 1,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        input.throttle = v
      },
    })
    controls.toggle({
      label: 'boost',
      value: boost,
      onChange: (v) => {
        boost = v
      },
    })
    controls.toggle({
      label: 'launched',
      value: launched,
      onChange: (v) => {
        launched = v
        reset()
      },
    })
    controls.button('chain a gate', () => chainGate(jet.chain))
    controls.button('restart', reset)
    readouts()
    draw()

    return {
      frame(dt) {
        clock.step(dt, tick)
        readouts()
        draw()
      },
      resize: (w, hgt) => {
        cv.resize(w, hgt)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
