/**
 * tests/unit/gpu-timer.test.ts — the GPU timer's protocol, against a fake GL.
 *
 * DEV-118. What is asserted is the part a real driver cannot be trusted to
 * exercise on demand: one query open at a time, results harvested in order and
 * only once available, a disjoint dropping everything in flight, and a timer
 * without the extension doing nothing at all.
 */
import { describe, expect, it } from 'vitest'
import { createGpuTimer, GPU_RING, type TimerGl } from '../../src/boot/gpu-timer'

interface FakeQuery {
  id: number
  ready: boolean
  ns: number
}

const fakeGl = (opts: { ext?: boolean } = {}) => {
  const queries: FakeQuery[] = []
  let disjoint = false
  let openTarget: number | null = null
  const log: string[] = []
  let next = 1
  const gl: TimerGl = {
    getExtension: (n) =>
      n === 'EXT_disjoint_timer_query_webgl2' && (opts.ext ?? true)
        ? { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb }
        : null,
    createQuery: () => {
      const q = { id: next++, ready: false, ns: 0 }
      queries.push(q)
      return q as unknown as WebGLQuery
    },
    deleteQuery: (q) => {
      log.push(`delete ${(q as unknown as FakeQuery).id}`)
    },
    beginQuery: (target, q) => {
      if (openTarget !== null) throw new Error('a query is already open')
      openTarget = target
      log.push(`begin ${(q as unknown as FakeQuery).id}`)
    },
    endQuery: () => {
      if (openTarget === null) throw new Error('no query open')
      openTarget = null
      log.push('end')
    },
    getQueryParameter: (q, pname) => {
      const f = q as unknown as FakeQuery
      return pname === 0x8867 ? f.ready : f.ns
    },
    getParameter: (pname) => (pname === 0x8fbb ? disjoint : null),
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
  }
  return {
    gl,
    log,
    queries,
    land: (id: number, ms: number) => {
      const q = queries.find((x) => x.id === id) as FakeQuery
      q.ready = true
      q.ns = ms * 1e6
    },
    setDisjoint: (v: boolean) => {
      disjoint = v
    },
  }
}

describe('gpu timer — DEV-118', () => {
  it('is inert without the extension, and says so', () => {
    const { gl, log } = fakeGl({ ext: false })
    const t = createGpuTimer(gl)
    expect(t.supported).toBe(false)
    t.enable()
    expect(t.enabled).toBe(false)
    t.begin()
    t.end()
    expect(log).toEqual([])
    expect(t.stats().frames).toBe(0)
  })

  it('does nothing until enabled, then brackets each frame with one query', () => {
    const { gl, log } = fakeGl()
    const t = createGpuTimer(gl)
    t.begin()
    t.end()
    expect(log).toEqual([])
    t.enable()
    t.begin()
    t.end()
    t.begin()
    t.end()
    expect(log.filter((l) => l.startsWith('begin'))).toHaveLength(2)
    expect(log.filter((l) => l === 'end')).toHaveLength(2)
  })

  it('harvests results in order, only once they have landed, and frees the query', () => {
    const { gl, log, land } = fakeGl()
    const t = createGpuTimer(gl)
    t.enable()
    t.begin()
    t.end() // query 1 pending
    t.begin()
    t.end() // query 2 pending
    expect(t.stats().frames).toBe(0)
    land(2, 5) // the newer one lands first — must NOT be read before the older
    t.begin()
    t.end()
    expect(t.stats().frames).toBe(0)
    land(1, 8)
    t.begin()
    t.end()
    const s = t.stats()
    expect(s.frames).toBe(2)
    expect(s.maxMs).toBeCloseTo(8)
    expect(s.medianMs).toBeCloseTo(8)
    expect(log).toContain('delete 1')
    expect(log).toContain('delete 2')
  })

  it('drops every pending query on a disjoint instead of recording a lie', () => {
    const { gl, log, land, setDisjoint } = fakeGl()
    const t = createGpuTimer(gl)
    t.enable()
    t.begin()
    t.end()
    land(1, 4)
    setDisjoint(true)
    t.begin()
    t.end()
    expect(t.stats().frames).toBe(0)
    expect(log.filter((l) => l.startsWith('delete'))).toHaveLength(2)
  })

  it('keeps a bounded ring and reports median, p95 and max in milliseconds', () => {
    const { gl, land, queries } = fakeGl()
    const t = createGpuTimer(gl)
    t.enable()
    for (let i = 0; i < GPU_RING + 20; i++) {
      t.begin()
      t.end()
      land((queries[queries.length - 1] as FakeQuery).id, i % 10)
      t.begin()
      t.end()
    }
    const s = t.stats()
    expect(s.frames).toBe(GPU_RING)
    expect(s.maxMs).toBe(9)
    expect(s.medianMs).toBeGreaterThanOrEqual(4)
    expect(s.medianMs).toBeLessThanOrEqual(5)
    expect(s.p95Ms).toBe(9)
    t.reset()
    expect(t.stats().frames).toBe(0)
  })

  it('publishes the newest landed result as `last`, counted by `harvested`', () => {
    // DEV-160 / VR-PERF §5.2. The per-frame trace stores `last` on EVERY frame
    // and marks the row fresh only where `harvested` advanced — which is the
    // only way to tell a new reading from a repeat of the one above, since
    // results land a frame or two late and skip frames.
    const { gl, land } = fakeGl()
    const t = createGpuTimer(gl)
    expect(Number.isNaN(t.last)).toBe(true)
    expect(t.harvested).toBe(0)

    t.enable()
    t.begin()
    t.end() // query 1 pending
    // Nothing has landed: `last` is still NaN, so a reader that ignored
    // `harvested` would store NaN rather than a stale-but-plausible number.
    expect(Number.isNaN(t.last)).toBe(true)
    expect(t.harvested).toBe(0)

    land(1, 7.5)
    t.begin()
    t.end()
    expect(t.last).toBeCloseTo(7.5)
    expect(t.harvested).toBe(1)

    // A frame where nothing landed REPEATS the value and does not advance the
    // counter. That pair is the whole contract.
    t.begin()
    t.end()
    expect(t.last).toBeCloseTo(7.5)
    expect(t.harvested).toBe(1)
  })

  it('a disjoint leaves `last` as it was — the dropped queries were never results', () => {
    const { gl, land, setDisjoint } = fakeGl()
    const t = createGpuTimer(gl)
    t.enable()
    t.begin()
    t.end()
    land(1, 3)
    t.begin()
    t.end()
    expect(t.last).toBeCloseTo(3)
    expect(t.harvested).toBe(1)

    // Query 3 would have landed at 99 ms; the disjoint invalidates it. A timer
    // that pushed it would put a clock change into the trace as a GPU cost.
    t.begin()
    t.end()
    land(3, 99)
    setDisjoint(true)
    t.begin()
    t.end()
    expect(t.last).toBeCloseTo(3)
    expect(t.harvested).toBe(1)
  })

  it('disable closes an open query rather than leaving the target held', () => {
    const { gl, log } = fakeGl()
    const t = createGpuTimer(gl)
    t.enable()
    t.begin()
    t.disable()
    expect(log).toContain('end')
    // A begin after disable is a no-op, so nothing throws about an open query.
    t.begin()
    t.end()
    expect(t.enabled).toBe(false)
  })
})
