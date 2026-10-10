// BE-14: the autosave and ring-rebuild debounce the three editor hosts each
// hand-rolled, as one helper.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebounce } from '@/editor/core'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createDebounce', () => {
  it('runs once, ms after the LAST schedule', () => {
    const run = vi.fn()
    const d = createDebounce(run, 400)
    d.schedule()
    vi.advanceTimersByTime(300)
    d.schedule()
    vi.advanceTimersByTime(300)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(d.pending()).toBe(false)
  })

  it('flush runs now, returns the action value, and drops the scheduled run', () => {
    const d = createDebounce(() => 'kept', 400)
    d.schedule()
    expect(d.pending()).toBe(true)
    expect(d.flush()).toBe('kept')
    expect(d.pending()).toBe(false)
  })

  it('a flushed action does not run again from the old timer', () => {
    const run = vi.fn()
    const d = createDebounce(run, 400)
    d.schedule()
    d.flush()
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cancel drops a scheduled run without running it', () => {
    const run = vi.fn()
    const d = createDebounce(run, 400)
    d.schedule()
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(run).not.toHaveBeenCalled()
  })

  it('reads its state when it fires, not when it was scheduled', () => {
    let level = 'a'
    const seen: string[] = []
    const d = createDebounce(() => seen.push(level), 100)
    d.schedule()
    level = 'b'
    d.schedule()
    vi.advanceTimersByTime(100)
    expect(seen).toEqual(['b'])
  })
})
