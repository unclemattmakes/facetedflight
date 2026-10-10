// T29, the engine voice. DEV-523 (docs/plan/MAKING-OF.md §4).
//
// Every sound in the game is synthesised in WebAudio from a recipe in
// `audio/cues.ts`: oscillators, filtered noise and envelopes, no recordings.
// This toy flies the real HoverJet (`stepHoverJet`) on the game's fixed clock
// and hands each tick's speed, throttle and boost to the game's real audio
// director (`createAudioSystem`), exactly as the game does. The look switch
// applies each edition preset's audio block the way `boot/app.ts` does:
// Classic is 2016's discrete loop swaps, Anniversary adds the speed curves,
// the rumble and the pitch that follows the speed.
//
// A browser will not make a sound before a gesture, so nothing plays until the
// reader presses start.

import { type AudioSystem, createAudioSystem } from '@/audio'
import { ENGINE_LOOPS } from '@/audio/engine'
import type { Edition } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import anniversary from '../../../content/editions/anniversary.json'
import classic from '../../../content/editions/classic.json'
import { createCanvas2D } from '../shared/canvas2d'
import { createToyClock, type ToyDef } from '../shared/toy-host'

type Look = 'classic' | 'anniversary'

const PRESETS: Record<Look, Edition> = {
  classic: validateEdition(classic as unknown as Edition),
  anniversary: validateEdition(anniversary as unknown as Edition),
}

export const toy: ToyDef = {
  id: 'engine-voice',
  title: 'Engine voice',
  caption:
    'Press start, then move the throttle and hold boost. Every sound here is built from oscillators and noise while you listen; there are no recordings.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    const clock = createToyClock()
    const jet = createHoverJet()
    jet.launched = true
    const input = noInput()
    let look: Look = 'anniversary'
    let audio: AudioSystem | null = null
    const history: number[] = []

    const applyLook = () => {
      if (!audio) return
      const e = PRESETS[look]
      audio.setSpeedCurves(e.audio.speedCurves.enabled ? e.audio.speedCurves : null)
      audio.setEngineSound(e.audio.engine)
    }

    const playing = (): string[] =>
      audio ? ENGINE_LOOPS.filter((id) => audio?.backend.isPlaying(id)) : []

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const loops = playing()
      const rowH = Math.min(34, (h - 20) / ENGINE_LOOPS.length)
      ctx.font = '12px "JetBrains Mono", monospace'
      ctx.textAlign = 'left'
      ENGINE_LOOPS.forEach((id, i) => {
        const on = loops.includes(id)
        const y = 14 + i * rowH
        ctx.fillStyle = on ? '#facf63' : 'rgba(194,200,229,0.12)'
        ctx.fillRect(16, y, 12, rowH - 10)
        ctx.fillStyle = on ? '#dfe4f2' : '#66738f'
        ctx.fillText(id, 38, y + rowH / 2)
      })
      // Speed over the last few seconds, on the right.
      const left = Math.max(220, w * 0.42)
      const max = Math.max(60, ...history) * 1.1
      ctx.beginPath()
      history.forEach((v, i) => {
        const x = left + (i / Math.max(1, history.length - 1)) * (w - left - 16)
        const y = h - 16 - (v / max) * (h - 40)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.strokeStyle = '#6fb4ff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = '#66738f'
      ctx.fillText('speed', left, 18)
    }

    const readouts = () => {
      const v = jet.body.velocity
      out.update([
        {
          label: 'sound',
          value: audio?.running ? 'on' : 'press start',
          tone: audio?.running ? 'good' : 'bad',
        },
        { label: 'speed', value: `${Math.hypot(v.x, v.y, v.z).toFixed(0)} m/s` },
        { label: 'loops', value: playing().join(', ') || 'none' },
      ])
    }

    controls.button('start sound', () => {
      if (!audio) {
        audio = createAudioSystem()
        applyLook()
      }
      void audio.resume()
    })
    controls.slider({
      label: 'throttle',
      min: 0,
      max: 1,
      step: 0.05,
      value: 0,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        input.throttle = v
      },
    })
    controls.toggle({
      label: 'boost',
      value: false,
      onChange: (v) => {
        input.boost = v
      },
    })
    controls.segmented<Look>({
      options: [
        { value: 'classic', label: 'Classic' },
        { value: 'anniversary', label: 'Anniversary' },
      ],
      value: look,
      onChange: (v) => {
        look = v
        applyLook()
      },
    })
    readouts()
    draw()

    let sample = 0
    return {
      frame(dt) {
        clock.step(dt, (fixed) => {
          stepHoverJet(jet, input, fixed)
          const v = jet.body.velocity
          audio?.stepFlight({
            speed: Math.hypot(v.x, v.y, v.z),
            throttle: input.throttle,
            boost: input.boost && input.throttle > 0,
            released: true,
          })
        })
        sample += dt
        if (sample > 0.05) {
          sample = 0
          const v = jet.body.velocity
          history.push(Math.hypot(v.x, v.y, v.z))
          if (history.length > 160) history.shift()
        }
        readouts()
        draw()
      },
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => {
        audio?.stopAll(0.1)
        audio?.dispose()
        cv.dispose()
      },
    }
  },
}
