// tests/unit/ui-caps.test.ts: CRYSTAL is a capitals face, so the 2-D context sets
// UI-stack text in capitals (DEV-848). Its lowercase is a degenerate cut: a d
// loses its stem and an i is a sliver, so "Edition" read "Edtion" on the pause plate.

import { describe, expect, it } from 'vitest'
import { installUiCaps } from '@/render/ui-font'
import { uiFont } from '@/render/ui-tokens'

const makeProto = () => {
  const calls: string[] = []
  return {
    calls,
    proto: {
      font: '',
      fillText(t: string) {
        calls.push(`fill:${t}`)
      },
      strokeText(t: string) {
        calls.push(`stroke:${t}`)
      },
      measureText(t: string) {
        calls.push(`measure:${t}`)
        return { width: t.length }
      },
    },
  }
}

describe('installUiCaps', () => {
  it('uppercases text set in the UI stack, for drawing and measuring alike', () => {
    const { proto, calls } = makeProto()
    installUiCaps([proto])
    proto.font = uiFont(30)
    proto.fillText('Edition')
    proto.strokeText('Edition')
    expect(proto.measureText('Edition')).toEqual({ width: 7 })
    expect(calls).toEqual(['fill:EDITION', 'stroke:EDITION', 'measure:EDITION'])
  })

  it('leaves the HUD stack and every other face alone', () => {
    const { proto, calls } = makeProto()
    installUiCaps([proto])
    proto.font = '400 20px "FF2 CRYSTAL", "Bahnschrift", "Segoe UI", sans-serif'
    proto.fillText('12 m')
    proto.font = '16px monospace'
    proto.fillText('mixed Case')
    expect(calls).toEqual(['fill:12 m', 'fill:mixed Case'])
  })

  it('is idempotent: a second install does not double-wrap', () => {
    const { proto, calls } = makeProto()
    installUiCaps([proto])
    installUiCaps([proto])
    proto.font = uiFont(30)
    proto.fillText('a')
    expect(calls).toEqual(['fill:A'])
  })
})
