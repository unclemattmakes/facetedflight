// tests/unit/submit-pin.test.ts: `?submit=` is a measurement switch that must
// default to today's frame and must not let a typo change the frame measured.
// DEV-971.
import { describe, expect, it } from 'vitest'
import { parseSubmitPin } from '@/boot/quality-pin'

describe('?submit= (DEV-971)', () => {
  it('is off when absent, off, or not understood', () => {
    const warnings: string[] = []
    const warn = (m: string) => warnings.push(m)
    expect(parseSubmitPin(null, warn)).toBe('off')
    expect(parseSubmitPin('off', warn)).toBe('off')
    expect(warnings).toEqual([])
    for (const typo of ['', 'on', '1', 'Flush', 'early']) {
      expect(parseSubmitPin(typo, warn), `?submit=${typo}`).toBe('off')
    }
    expect(warnings.length, 'every unknown spelling is said').toBe(5)
  })

  it('reads the two arms by name', () => {
    expect(parseSubmitPin('flush')).toBe('flush')
    expect(parseSubmitPin('reorder')).toBe('reorder')
  })
})
