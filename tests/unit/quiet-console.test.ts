// tests/unit/quiet-console.test.ts: a worn `?perf=1` session silences log, info,
// debug and warn, keeps error, and hands every method back on sessionend.

import { describe, expect, it, vi } from 'vitest'
import { createQuietConsole, QUIETED } from '@/boot/quiet-console'

const fakeConsole = () => ({
  log: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
})

describe('createQuietConsole', () => {
  it('silences the chatty methods and keeps error', () => {
    const c = fakeConsole()
    const originals = { ...c }
    const q = createQuietConsole(c)
    q.set(true)
    expect(q.quiet).toBe(true)
    for (const k of QUIETED) {
      c[k]('x')
      expect(originals[k]).not.toHaveBeenCalled()
    }
    c.error('kept')
    expect(originals.error).toHaveBeenCalledWith('kept')
  })

  it('restores the very same functions, so call sites stay their own', () => {
    const c = fakeConsole()
    const originals = { ...c }
    const q = createQuietConsole(c)
    q.set(true)
    q.set(true) // a second sessionstart must not save the silent ones
    q.set(false)
    expect(q.quiet).toBe(false)
    for (const k of QUIETED) expect(c[k]).toBe(originals[k])
  })

  it('does nothing when asked to restore what was never quieted', () => {
    const c = fakeConsole()
    const originals = { ...c }
    createQuietConsole(c).set(false)
    for (const k of QUIETED) expect(c[k]).toBe(originals[k])
  })
})
