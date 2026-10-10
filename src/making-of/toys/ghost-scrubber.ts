// T24, the ghost scrubber. DEV-519 (docs/plan/MAKING-OF.md §4).
//
// 2016 raced you against recordings: two ghosts per mission, flown once by the
// developers. Here are the two for `int_01_hoverJet`, decoded by the game's own
// `decodeGhostClip` and sampled by its own `sampleGhost`. Scrub the clock and
// both ships sit where they sat in the recording. The dots are the recorded
// keys, which is all a clip is: a few thousand poses and an interpolation
// between them.

import { decodeGhostClip, type GhostDoc, type GhostPose, sampleGhost } from '@/sim/ghost'
import fast from '../../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slow from '../../../content/ghosts/int_01_rightSpawn_slow_01.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

const COLOURS = ['#facf63', '#6fb4ff'] as const

export const toy: ToyDef = {
  id: 'ghost-scrubber',
  title: 'Ghost scrubber',
  caption:
    'Two recordings from 2016, played by the game’s own decoder. Drag the clock; the faster ghost pulls away. Show the keys to see what a recording is made of.',
  kind: '2d',
  mount({ stage, controls }) {
    const clips = [fast, slow].map((doc) => ({
      name: (doc as { name?: string }).name ?? 'ghost',
      clip: decodeGhostClip(doc as unknown as GhostDoc),
    }))
    const longest = Math.max(...clips.map((c) => c.clip.duration))
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    let t = 0
    let showKeys = false
    let playing = true
    const pose: GhostPose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

    const bounds = () => {
      let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity]
      for (const { clip } of clips) {
        for (let k = 0; k < clip.keyCount; k++) {
          const x = clip.data[k * 8 + 1] as number
          const z = clip.data[k * 8 + 3] as number
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          z0 = Math.min(z0, z)
          z1 = Math.max(z1, z)
        }
      }
      return { x0, x1, z0, z1 }
    }
    const box = bounds()

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const pad = 24
      const s = Math.min((w - pad * 2) / (box.x1 - box.x0), (h - pad * 2) / (box.z1 - box.z0))
      const px = (x: number) => (w - (box.x1 - box.x0) * s) / 2 + (x - box.x0) * s
      const pz = (z: number) => (h - (box.z1 - box.z0) * s) / 2 + (z - box.z0) * s
      const rows: { label: string; value: string }[] = [
        { label: 'clock', value: `${t.toFixed(1)} s` },
      ]
      clips.forEach(({ name, clip }, i) => {
        const colour = COLOURS[i % COLOURS.length] ?? '#fff'
        ctx.beginPath()
        for (let k = 0; k < clip.keyCount; k++) {
          const x = px(clip.data[k * 8 + 1] as number)
          const z = pz(clip.data[k * 8 + 3] as number)
          if (k === 0) ctx.moveTo(x, z)
          else ctx.lineTo(x, z)
        }
        ctx.strokeStyle = `${colour}55`
        ctx.lineWidth = 1.5
        ctx.stroke()
        if (showKeys) {
          ctx.fillStyle = colour
          for (let k = 0; k < clip.keyCount; k++) {
            ctx.fillRect(
              px(clip.data[k * 8 + 1] as number) - 1,
              pz(clip.data[k * 8 + 3] as number) - 1,
              2,
              2,
            )
          }
        }
        const at = Math.min(t, clip.duration)
        sampleGhost(clip, at, pose)
        const [x, z] = [pose.px, pose.pz]
        sampleGhost(clip, Math.min(at + 0.1, clip.duration), pose)
        const speed = Math.hypot(pose.px - x, pose.pz - z) / 0.1
        ctx.beginPath()
        ctx.arc(px(x), pz(z), 6, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.fill()
        rows.push({
          label: `${name.replace(/^int_01_/, '')}`,
          value: `${speed.toFixed(0)} m/s, ${clip.keyCount} keys`,
        })
      })
      out.update(rows)
    }

    const time = controls.slider({
      label: 'clock',
      min: 0,
      max: longest,
      step: 0.1,
      value: 0,
      format: (v) => `${v.toFixed(1)} s`,
      onInput: (v) => {
        t = v
        playing = false
        draw()
      },
    })
    controls.toggle({
      label: 'show the recorded keys',
      value: showKeys,
      onChange: (v) => {
        showKeys = v
        draw()
      },
    })
    controls.button('play', () => {
      if (t >= longest) t = 0
      playing = true
    })
    draw()
    return {
      frame(dt) {
        if (playing) {
          t = Math.min(longest, t + dt)
          if (t >= longest) playing = false
          time.set(t)
          draw()
        }
      },
      resize: (w, hh) => {
        cv.resize(w, hh)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
