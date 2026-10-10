// T16, the response curve. DEV-517 (docs/plan/MAKING-OF.md §4).
//
// Anniversary's terrain is lit through an illustrative warp (the Team Fortress
// 2 paper's): the direct diffuse response becomes a ramp over Half-Lambert, so
// a facet turned away from the sun gets a cool fill where plain Lambert gives
// it nothing, and one edge-on takes the warm terminator colour whole. The ramp
// is `illustrativeIrradiance`, the same expression the shader patch runs, line
// for line; the settings are the Anniversary preset's own `render.illustrative`.
//
// Left: the curve against N.L. Right: a faceted dome shaded through it, one
// flat colour per facet, the way the game's terrain takes it.

import type { Edition } from '@/content/edition-schema'
import { validateEdition } from '@/content/edition-schema'
import {
  ILLUSTRATIVE_OFF,
  type IllustrativeSettings,
  illustrativeIrradiance,
} from '@/render/illustrative'
import anniversary from '../../../content/editions/anniversary.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

const RINGS = 6
const SECTORS = 18
const SUN_COLOUR = [1, 0.96, 0.88] as const

/** Linear light to an 8-bit display value, through a plain 2.2 gamma: the canvas is sRGB. */
const toByte = (v: number) =>
  Math.max(0, Math.min(255, Math.round(255 * Math.max(0, v) ** (1 / 2.2))))

export const toy: ToyDef = {
  id: 'response-curve',
  title: 'Response curve',
  caption:
    'Swing the sun around behind the dome. With the warp off, every facet facing away is black; with it on, they take a cool fill, and the edge-on ones turn warm.',
  kind: '2d',
  mount({ stage, controls }) {
    const preset = validateEdition(anniversary as unknown as Edition).render.illustrative
    const shipped: IllustrativeSettings = preset
    let strength = shipped.strength
    let sunDeg = 70
    const cv = createCanvas2D(stage)
    const out = controls.readouts()

    const settings = (): IllustrativeSettings => ({ ...shipped, strength })

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const s = settings()
      // ── the curve ──
      const split = w * 0.5
      const x0 = 30
      const x1 = split - 20
      const top = 20
      const bottom = h - 30
      const maxY = Math.max(
        1.2,
        ...[shipped.lit, shipped.terminator].flat().map((v) => v * shipped.overbright),
      )
      const X = (nl: number) => x0 + ((nl + 1) / 2) * (x1 - x0)
      const Y = (v: number) => bottom - (v / maxY) * (bottom - top)
      ctx.strokeStyle = 'rgba(194,200,229,0.15)'
      ctx.beginPath()
      ctx.moveTo(X(0), top)
      ctx.lineTo(X(0), bottom)
      ctx.moveTo(x0, bottom)
      ctx.lineTo(x1, bottom)
      ctx.stroke()
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.fillStyle = '#66738f'
      ctx.textAlign = 'center'
      ctx.fillText('N·L', (x0 + x1) / 2, h - 10)
      ctx.fillText('terminator', X(0), top - 6)
      const curve = (channel: number, colour: string, settingsFor: IllustrativeSettings) => {
        ctx.beginPath()
        for (let i = 0; i <= 120; i++) {
          const nl = -1 + (2 * i) / 120
          const v = illustrativeIrradiance(nl, [1, 1, 1], settingsFor)[channel] as number
          if (i === 0) ctx.moveTo(X(nl), Y(v))
          else ctx.lineTo(X(nl), Y(v))
        }
        ctx.strokeStyle = colour
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.setLineDash([4, 4])
      curve(0, 'rgba(194,200,229,0.6)', ILLUSTRATIVE_OFF)
      ctx.setLineDash([])
      curve(0, '#ff8a7a', s)
      curve(1, '#7ee0a4', s)
      curve(2, '#6fb4ff', s)
      ctx.lineWidth = 1

      // ── the dome ──
      const cx = split + (w - split) / 2
      const cy = h / 2
      const R = Math.min((w - split) / 2, h / 2) - 16
      const a = (sunDeg * Math.PI) / 180
      const L = [Math.sin(a), 0.25, Math.cos(a)]
      const len = Math.hypot(L[0] as number, L[1] as number, L[2] as number)
      const lx = (L[0] as number) / len
      const ly = (L[1] as number) / len
      const lz = (L[2] as number) / len
      let away = 0
      for (let r = 0; r < RINGS; r++) {
        for (let k = 0; k < SECTORS; k++) {
          const r0 = r / RINGS
          const r1 = (r + 1) / RINGS
          const t0 = (k / SECTORS) * Math.PI * 2
          const t1 = ((k + 1) / SECTORS) * Math.PI * 2
          // The facet's normal at its middle, on a unit dome seen from above.
          const rm = (r0 + r1) / 2
          const tm = (t0 + t1) / 2
          const nx = rm * Math.cos(tm)
          const ny = rm * Math.sin(tm)
          const nz = Math.sqrt(Math.max(0, 1 - rm * rm))
          const nl = nx * lx + -ny * ly + nz * lz
          if (nl < 0) away++
          const c = illustrativeIrradiance(nl, SUN_COLOUR, s)
          ctx.beginPath()
          ctx.moveTo(cx + R * r0 * Math.cos(t0), cy + R * r0 * Math.sin(t0))
          ctx.lineTo(cx + R * r1 * Math.cos(t0), cy + R * r1 * Math.sin(t0))
          ctx.lineTo(cx + R * r1 * Math.cos(t1), cy + R * r1 * Math.sin(t1))
          ctx.lineTo(cx + R * r0 * Math.cos(t1), cy + R * r0 * Math.sin(t1))
          ctx.closePath()
          ctx.fillStyle = `rgb(${toByte(c[0] as number)},${toByte(c[1] as number)},${toByte(c[2] as number)})`
          ctx.fill()
        }
      }
      out.update([
        { label: 'warp strength', value: strength.toFixed(2) },
        { label: 'facets facing away', value: `${away} of ${RINGS * SECTORS}` },
        { label: 'Anniversary ships', value: shipped.strength.toFixed(2) },
      ])
    }

    controls.slider({
      label: 'sun',
      min: 0,
      max: 180,
      step: 1,
      value: sunDeg,
      format: (v) => `${v}°`,
      onInput: (v) => {
        sunDeg = v
        draw()
      },
    })
    const strengthSlider = controls.slider({
      label: 'warp',
      min: 0,
      max: 1,
      step: 0.05,
      value: strength,
      format: (v) => v.toFixed(2),
      onInput: (v) => {
        strength = v
        draw()
      },
    })
    controls.segmented<'classic' | 'anniversary'>({
      options: [
        { value: 'classic', label: 'Classic (off)' },
        { value: 'anniversary', label: 'Anniversary' },
      ],
      value: 'anniversary',
      onChange: (v) => {
        strength = v === 'classic' ? 0 : shipped.strength
        strengthSlider.set(strength)
        draw()
      },
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
