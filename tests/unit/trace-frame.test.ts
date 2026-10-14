// tests/unit/trace-frame.test.ts: the frame critical-path reducer, on a trace small
// enough to check by hand. DEV-970.
//
// The numbers in the synthetic trace are chosen so each column has a DIFFERENT
// answer from its neighbours (a test where js, gpuEnd and present all agree would
// pass a reducer that returned any of them). Times are microseconds, as in a
// Chrome trace.
import { describe, expect, it } from 'vitest'
import { type FrameRow, reduceFrameTrace, stat } from '../../tools/perf/trace-frame.mjs'

const RENDERER = 100
const GPU = 200
const MAIN = 1
const GPUMAIN = 2

const meta = [
  { ph: 'M', name: 'process_name', pid: RENDERER, args: { name: 'Renderer' } },
  { ph: 'M', name: 'process_name', pid: GPU, args: { name: 'GPU Process' } },
  { ph: 'M', name: 'thread_name', pid: RENDERER, tid: MAIN, args: { name: 'CrRendererMain' } },
  { ph: 'M', name: 'thread_name', pid: GPU, tid: GPUMAIN, args: { name: 'CrGpuMain' } },
]

const raf = (ts: number, dur: number) => ({
  ph: 'X',
  name: 'FunctionCall',
  cat: 'devtools.timeline',
  pid: RENDERER,
  tid: MAIN,
  ts,
  dur,
  args: { data: { functionName: 'onAnimationFrame' } },
})
const rflush = (ts: number, put: number) => ({
  ph: 'X',
  name: 'CommandBufferProxyImpl::Flush',
  cat: 'gpu',
  pid: RENDERER,
  tid: MAIN,
  ts,
  dur: 10,
  args: { put_offset: put },
})
const gflush = (ts: number, dur: number, put: number) => ({
  ph: 'X',
  name: 'CommandBufferStub::OnAsyncFlush',
  cat: 'gpu',
  pid: GPU,
  tid: GPUMAIN,
  ts,
  dur,
  args: { put_offset: put },
})
const slice = (b: number, e: number) => [
  {
    ph: 'b',
    name: 'WebGL-0x1',
    cat: 'disabled-by-default-gpu.service',
    pid: GPU,
    tid: GPUMAIN,
    ts: b,
    id2: { local: '0x16' },
  },
  {
    ph: 'e',
    name: 'WebGL-0x1',
    cat: 'disabled-by-default-gpu.service',
    pid: GPU,
    tid: GPUMAIN,
    ts: e,
    id2: { local: '0x16' },
  },
]
const present = (ts: number, dur: number) => ({
  ph: 'X',
  name: 'DCompPresenter::Present',
  cat: 'gpu',
  pid: GPU,
  tid: GPUMAIN,
  ts,
  dur,
})

describe('trace-frame reducer (DEV-970)', () => {
  // Frame 0: rAF 10 000 to 15 000 (js 5 ms). Flushes at +2 ms (put 1) and +4.5 ms (put 2).
  // The GPU process starts put 1 at +3.5 ms (1.5 ms queue), put 2 at +6 ms (1.5 ms queue),
  // and the second one's GPU execution ends at +9 ms. Present starts at +12 ms, 0.5 ms long.
  // Frame 1 starts at 20 000 (period 10 ms) and only exists to bound frame 0.
  const events = [
    ...meta,
    raf(10_000, 5_000),
    rflush(12_000, 1),
    rflush(14_500, 2),
    gflush(13_500, 300, 1),
    ...slice(13_550, 14_800),
    gflush(16_000, 400, 2),
    ...slice(16_050, 19_000),
    present(22_000, 500),
    raf(20_000, 4_000),
  ]

  it('reads every column of the first frame from the right event', () => {
    const r = reduceFrameTrace(events)
    expect(r.rendererPid).toBe(RENDERER)
    expect(r.gpuPid).toBe(GPU)
    const f = r.frames[0] as FrameRow
    expect(f.js).toBeCloseTo(5, 6)
    expect(f.flushes).toBe(2)
    expect(f.firstFlush).toBeCloseTo(2, 6)
    expect(f.lastFlush).toBeCloseTo(4.5, 6)
    // The last flush went out 0.5 ms BEFORE the callback ended.
    expect(f.lastFlushAfterJs).toBeCloseTo(-0.5, 6)
    expect(f.queueMax).toBeCloseTo(1.5, 6)
    expect(f.queueSum).toBeCloseTo(3, 6)
    expect(f.gpuStart).toBeCloseTo(3.5, 6)
    expect(f.gpuEnd).toBeCloseTo(9, 6)
    expect(f.gpuTail).toBeCloseTo(4, 6)
    // Present starts at 22 000 and ends at 22 500, after frame 1's JS has started.
    expect(f.presentEnd).toBeCloseTo(12.5, 6)
  })

  it('names the gap as present start minus the later of JS end and GPU end', () => {
    const r = reduceFrameTrace(events)
    // GPU ended at 19 000, JS at 15 000; present at 22 000: 3 ms nobody owns.
    expect((r.frames[0] as FrameRow).gap).toBeCloseTo(3, 6)
  })

  it('finds no frames, and says so, in a trace with no rAF callbacks', () => {
    const r = reduceFrameTrace(meta)
    expect(r.frames).toEqual([])
    expect(r.rendererPid).toBeNull()
  })

  it('gives the period from the previous callback', () => {
    const r = reduceFrameTrace(events)
    expect((r.frames[1] as FrameRow).period).toBeCloseTo(10, 6)
  })

  it('stat reads p50, p95 and max and ignores nulls', () => {
    expect(stat([1, 2, 3, 4, null as unknown as number])).toEqual({ n: 4, p50: 3, p95: 4, max: 4 })
  })
})
