// T07, the medal calculator. DEV-515 (docs/plan/MAKING-OF.md §4).
//
// Slide how many rings you take on `rookie_01_hoverJet` and read the medal off
// the game's own `awardMedal`, against 2016's thresholds and against the ones
// the game ships. The ring count, the ceiling and the thresholds all come out
// of the level JSON through the game's own functions; nothing is retyped.

import type { Level } from '@/content/level-schema'
import { liveRings, maxRingScore, validateLevel } from '@/content/level-schema'
import { awardMedal } from '@/game/mission'
import raw from '../../../content/levels/rookie_01_hoverJet.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

type Curve = 'classic' | 'shipped'

const MEDAL_COLOUR: Record<string, string> = {
  none: '#66738f',
  bronze: '#cd8c52',
  silver: '#c9d1e0',
  gold: '#facf63',
  platinum: '#9fe7ff',
}

export const toy: ToyDef = {
  id: 'medal-calculator',
  title: 'Medal calculator',
  caption:
    'Take rings and read the medal. Switch to 2016’s thresholds and watch the platinum line land beyond the dashed ceiling: no run can score it.',
  kind: '2d',
  mount({ stage, controls }) {
    const level: Level = validateLevel(raw as unknown as Level)
    const ringTotal = liveRings(level).length
    const ceiling = maxRingScore(level)
    const gate = level.scoring.gateMultiplier
    let rings = Math.floor(ringTotal / 2)
    let curve: Curve = 'classic'
    const cv = createCanvas2D(stage)
    const out = controls.readouts()

    const curveOf = () => (curve === 'classic' ? level.medals : (level.medalsFf2 ?? level.medals))

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const c = curveOf()
      const score = rings * gate
      const margin = 28
      const x0 = margin
      const x1 = w - margin
      const scale = (v: number) => x0 + (v / Math.max(ceiling, c.platinum)) * (x1 - x0)
      const y = h * 0.52
      ctx.font = '12px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      // Centre a label on `x`, kept inside the stage.
      const put = (text: string, x: number, yy: number) => {
        const half = ctx.measureText(text).width / 2 + 4
        ctx.fillText(text, Math.min(Math.max(x, half), w - half), yy)
      }
      ctx.fillStyle = 'rgba(194,200,229,0.12)'
      ctx.fillRect(x0, y - 14, x1 - x0, 28)
      ctx.fillStyle = '#facf63'
      ctx.fillRect(x0, y - 14, scale(score) - x0, 28)
      // The ceiling this course can reach, and each threshold.
      ctx.strokeStyle = '#6fb4ff'
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(scale(ceiling), y - 40)
      ctx.lineTo(scale(ceiling), y + 40)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#6fb4ff'
      put(`ceiling ${ceiling}`, scale(ceiling), y + 56)
      for (const tier of ['bronze', 'silver', 'gold', 'platinum'] as const) {
        const x = scale(c[tier])
        ctx.strokeStyle = MEDAL_COLOUR[tier] ?? '#fff'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x, y - 24)
        ctx.lineTo(x, y + 24)
        ctx.stroke()
        ctx.fillStyle = MEDAL_COLOUR[tier] ?? '#fff'
        put(`${tier} ${c[tier]}`, x, y - 34 - (tier === 'platinum' ? 16 : 0))
      }
      ctx.lineWidth = 1
    }

    const refresh = () => {
      const c = curveOf()
      const medal = awardMedal(rings * gate, c)
      const reachable = ceiling >= c.platinum
      out.update([
        { label: 'rings', value: `${rings} / ${ringTotal}` },
        { label: 'score', value: String(rings * gate) },
        { label: 'medal', value: medal.toUpperCase() },
        {
          label: 'platinum',
          value: reachable ? 'reachable' : `needs ${c.platinum}, course holds ${ceiling}`,
          tone: reachable ? 'good' : 'bad',
        },
      ])
      draw()
    }

    controls.slider({
      label: 'rings taken',
      min: 0,
      max: ringTotal,
      step: 1,
      value: rings,
      onInput: (v) => {
        rings = v
        refresh()
      },
    })
    controls.segmented<Curve>({
      options: [
        { value: 'classic', label: '2016 thresholds' },
        { value: 'shipped', label: 'Anniversary' },
      ],
      value: curve,
      onChange: (v) => {
        curve = v
        refresh()
      },
    })
    refresh()
    return {
      resize: (w, h) => {
        cv.resize(w, h)
        refresh()
      },
      dispose: () => cv.dispose(),
    }
  },
}
