// tests/unit/ui-draw.test.ts: the plates' shared drawing (UI-6, UI-7).
//
// `drawPlate` (DEV-647's broadcast plate: flat, a hairline, one accent bar) is
// checked as a CALL SEQUENCE against a recording context, and as GEOMETRY: no
// rounded corner is ever asked for. `wrapParts` is checked against the two loops
// it replaced (`briefing.ts`'s word wrap and `tv-panel-layout.ts`'s ident wrap),
// kept here verbatim as the oracle.

import { describe, expect, it } from 'vitest'
import { wrapIdentLine } from '@/render/tv-panel-layout'
import {
  drawPlate,
  drawSelectedRow,
  type PlateContext,
  wrapParts,
  wrapText,
} from '@/render/ui-draw'
import { UI_ACCENT, UI_PLATE, UI_PLATE_EDGE, UI_SELECTED_FILL } from '@/render/ui-tokens'

const recorder = () => {
  const log: string[] = []
  const ctx = {
    beginPath: () => log.push('beginPath'),
    rect: (...a: number[]) => log.push(`rect(${a.join(',')})`),
    fillRect: (...a: number[]) => log.push(`fillRect(${a.join(',')})`),
    fill: () => log.push('fill'),
    stroke: () => log.push('stroke'),
    set fillStyle(v: string) {
      log.push(`fillStyle=${v}`)
    },
    set strokeStyle(v: string) {
      log.push(`strokeStyle=${v}`)
    },
    set lineWidth(v: number) {
      log.push(`lineWidth=${v}`)
    },
  }
  return { log, ctx: ctx as unknown as PlateContext }
}

describe('drawPlate', () => {
  it('draws flat: the fill, the hairline inside the edge, then the accent bar on the left', () => {
    const { log, ctx } = recorder()
    drawPlate(ctx, 784, 476, { bar: 12, lineWidth: 4 })
    expect(log).toEqual([
      'beginPath',
      'rect(0,0,784,476)',
      `fillStyle=${UI_PLATE}`,
      'fill',
      'beginPath',
      'rect(2,2,780,472)',
      'lineWidth=4',
      `strokeStyle=${UI_PLATE_EDGE}`,
      'stroke',
      `fillStyle=${UI_ACCENT}`,
      'fillRect(0,0,12,476)',
    ])
  })

  it('takes its own fill, stroke and bar ink where a plate has a variant look', () => {
    const { log, ctx } = recorder()
    drawPlate(ctx, 10, 10, { bar: 1, lineWidth: 2, fill: 'red', stroke: 'blue', accent: 'green' })
    expect(log).toContain('fillStyle=red')
    expect(log).toContain('strokeStyle=blue')
    expect(log).toContain('fillStyle=green')
  })
})

describe('drawSelectedRow', () => {
  it('washes the row and puts the accent bar on its left edge', () => {
    const { log, ctx } = recorder()
    drawSelectedRow(ctx, 5, 6, 100, 20, 3)
    expect(log).toEqual([
      `fillStyle=${UI_SELECTED_FILL}`,
      'fillRect(5,6,100,20)',
      `fillStyle=${UI_ACCENT}`,
      'fillRect(5,6,3,20)',
    ])
  })
})

/** briefing.ts's `wrapText`, as it was. */
const oldWrapText = (text: string, maxWidth: number, measure: (s: string) => number): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measure(candidate) > maxWidth) {
      lines.push(line)
      line = word
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines
}

/** tv-panel-layout.ts's `wrapIdentLine`, as it was. */
const oldWrapIdent = (measure: (s: string) => number, line: string, maxW: number): string[] => {
  const parts = line.split(' · ')
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    const next = cur ? `${cur} · ${p}` : p
    if (cur && measure(next) > maxW) {
      out.push(cur)
      cur = p
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

const width5 = (s: string) => s.length * 5

describe('wrapParts', () => {
  const texts = [
    '',
    '   ',
    'a',
    'the quick brown fox jumps over the lazy dog',
    '  leading and   trailing   ',
    'supercalifragilisticexpialidocious is longer than the line',
    'x '.repeat(80),
  ]

  it('wrapText is the word wrap it replaced, for every width', () => {
    for (const t of texts) {
      for (const w of [1, 20, 60, 200, 10_000]) {
        expect(wrapText(t, w, width5), `${JSON.stringify(t)} @ ${w}`).toEqual(
          oldWrapText(t, w, width5),
        )
      }
    }
  })

  it('wrapIdentLine is the ident wrap it replaced, including empty parts', () => {
    const idents = [
      '',
      'A',
      'A · BB · CCC · DDDD · EEEEE · F',
      'A ·  · B',
      ' · A',
      'A · ',
      'ROOKIE · 3 LAPS · 5 RACERS · ANNIVERSARY · HOVERJET · SIMONET ISLANDS',
    ]
    for (const t of idents) {
      for (const w of [1, 5, 40, 70, 10_000]) {
        expect(
          wrapIdentLine({ measureText: (s) => ({ width: width5(s) }) }, t, w),
          `${JSON.stringify(t)} @ ${w}`,
        ).toEqual(oldWrapIdent(width5, t, w))
      }
    }
  })

  it('joins with the joiner it is given and keeps an over-long part whole', () => {
    expect(wrapParts(['aa', 'bb', 'cc'], ' | ', 40, width5)).toEqual(['aa | bb', 'cc'])
    expect(wrapParts(['averyveryverylongone', 'b'], ' ', 5, width5)).toEqual([
      'averyveryverylongone',
      'b',
    ])
  })
})
