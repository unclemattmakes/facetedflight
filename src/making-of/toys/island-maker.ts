// A new island from five numbers. Making-of, the course editor chapter.
//
// The course editor's "New island from a seed" dialog is a seed and four
// sliders over the game's `synthesiseIsland` (`sim/terrain/island-synth.ts`,
// DEV-493). This toy is the same function with the same sliders, the same
// bounds (`PLAYER_COURSE_ISLAND`) and the same sizes, drawn top-down with a
// simple height ramp and a hill shade. What a course stores for its island is
// those five numbers and the generator's version, which is why a seeded island
// fits in a link: wherever the link is opened, the ground is made again.

import { islandChunkMetres, PLAYER_COURSE_ISLAND } from '@/content/player-course'
import { ISLAND_SYNTH, ISLAND_SYNTH_VERSION, synthesiseIsland } from '@/sim/terrain/island-synth'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

/** Samples a side. The editor's own preview takes 129; this is a little finer. */
const EDGE = 161

/** The height ramp, land 0..1 above the sea: sand, grass, forest, rock, snow. */
const LAND: readonly [number, number, number, number][] = [
  [0, 222, 205, 150],
  [0.012, 120, 170, 90],
  [0.35, 60, 120, 70],
  [0.65, 125, 115, 105],
  [0.85, 235, 238, 242],
]

const ramp = (e: number): [number, number, number] => {
  if (e < 0) {
    const d = Math.min(1, -e)
    return [30 - 20 * d, 110 - 60 * d, 160 - 60 * d]
  }
  for (let i = LAND.length - 1; i >= 0; i--) {
    const stop = LAND[i] as [number, number, number, number]
    if (e >= stop[0]) {
      const next = LAND[i + 1]
      if (!next) return [stop[1], stop[2], stop[3]]
      const f = (e - stop[0]) / (next[0] - stop[0])
      return [
        stop[1] + (next[1] - stop[1]) * f,
        stop[2] + (next[2] - stop[2]) * f,
        stop[3] + (next[3] - stop[3]) * f,
      ]
    }
  }
  return [LAND[0]?.[1] ?? 0, LAND[0]?.[2] ?? 0, LAND[0]?.[3] ?? 0]
}

export const toy: ToyDef = {
  id: 'island-maker',
  title: 'New island from a seed',
  caption:
    'The course editor’s island generator, with its own sliders. Every island here is a seed and four numbers, small enough to share in a link.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    const I = PLAYER_COURSE_ISLAND
    const chunk = islandChunkMetres('simonet') ?? 256
    const sizes: number[] = []
    for (let s = chunk * 4; s <= I.maxSize; s *= 2) sizes.push(s)

    let seed = 4183
    let size = sizes.includes(4096) ? 4096 : (sizes[sizes.length - 1] as number)
    let height = 300
    let rugged = 0.5
    let sea = 0.45
    let ms = 0

    const image = document.createElement('canvas')
    image.width = EDGE
    image.height = EDGE
    const ictx = image.getContext('2d')
    if (!ictx) throw new Error('making-of: no 2D canvas context')
    const pixels = ictx.createImageData(EDGE, EDGE)

    const build = () => {
      const t0 = performance.now()
      const shape = { size, height, rugged, sea }
      const e = synthesiseIsland(seed, shape, EDGE, ISLAND_SYNTH_VERSION)
      // Metres a sample, and the slope that reads as fully lit or fully shaded.
      const step = size / (EDGE - 1)
      for (let row = 0; row < EDGE; row++) {
        for (let col = 0; col < EDGE; col++) {
          const i = row * EDGE + col
          const v = e[i] as number
          const [r, g, b] = ramp(v)
          let shade = 1
          if (v > 0) {
            const west = e[i - (col > 0 ? 1 : 0)] as number
            const north = e[i - (row > 0 ? EDGE : 0)] as number
            const dx = ((v - west) * height) / step
            const dz = ((v - north) * height) / step
            shade = Math.max(0.45, Math.min(1.35, 1 + (dx + dz) * 0.9))
          }
          pixels.data[i * 4] = Math.min(255, r * shade)
          pixels.data[i * 4 + 1] = Math.min(255, g * shade)
          pixels.data[i * 4 + 2] = Math.min(255, b * shade)
          pixels.data[i * 4 + 3] = 255
        }
      }
      ictx.putImageData(pixels, 0, 0)
      ms = performance.now() - t0
      draw()
      readouts()
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const side = Math.min(w, h) - 16
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(image, (w - side) / 2, (h - side) / 2, side, side)
      // A kilometre, for scale.
      const km = (side * 1000) / size
      const x = (w - side) / 2 + 10
      const y = (h + side) / 2 - 12
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillRect(x, y, km, 3)
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.fillText('1 km', x, y - 5)
    }

    const readouts = () => {
      out.update([
        { label: 'seed', value: String(seed) },
        {
          label: 'what the course stores',
          value: `seed ${seed}, ${size.toLocaleString('en-US')} m across, ${height} m high, rugged ${rugged.toFixed(2)}, sea ${sea.toFixed(2)}, generator v${ISLAND_SYNTH_VERSION}`,
        },
        { label: 'made in', value: `${Math.round(ms)} ms` },
      ])
    }

    controls.button('new seed', () => {
      seed = Math.floor(Math.random() * (ISLAND_SYNTH.seedMax + 1))
      build()
    })
    controls.segmented<string>({
      options: sizes.map((s) => ({ value: String(s), label: `${Math.round(s / 1000)} km` })),
      value: String(size),
      onChange: (v) => {
        size = Number(v)
        build()
      },
    })
    controls.slider({
      label: 'highest point',
      min: I.minHeight,
      max: Math.min(600, I.maxTerrainHeight),
      step: 10,
      value: height,
      format: (v) => `${v} m`,
      onInput: (v) => {
        height = v
        build()
      },
    })
    controls.slider({
      label: 'rugged',
      min: 0,
      max: 1,
      step: 0.01,
      value: rugged,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        rugged = v
        build()
      },
    })
    controls.slider({
      label: 'how much sea',
      min: 0,
      max: 1,
      step: 0.01,
      value: sea,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        sea = v
        build()
      },
    })

    build()
    return {
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
