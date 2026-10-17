// tests/unit/trace-frame.test.ts: the frame critical-path reducer, on a trace small
// enough to check by hand. DEV-970.
//
// The numbers in the synthetic trace are chosen so each column has a DIFFERENT
// answer from its neighbours (a test where js, gpuEnd and present all agree would
// pass a reducer that returned any of them). Times are microseconds, as in a
// Chrome trace.
import { describe, expect, it } from 'vitest'
import { type FrameRow, keepEvent, reduceFrameTrace, stat } from '../../tools/perf/trace-frame.mjs'

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

describe('trace-frame reducer, XR roles, slow frames and queue culprits (DEV-993)', () => {
  const XR = 300
  const XRTID = 7
  const xrMeta = [
    ...meta,
    { ph: 'M', name: 'process_name', pid: XR, args: { name: 'Utility: XR Device Service' } },
    { ph: 'M', name: 'thread_name', pid: XR, tid: XRTID, args: { name: 'XrRenderLoop' } },
  ]
  const xrEv = (name: string, ts: number, dur: number, pid = XR, tid = XRTID, cat = 'xr') => ({
    ph: 'X',
    name,
    cat,
    pid,
    tid,
    ts,
    dur,
  })
  // Six callbacks 10 ms apart, the last 25 ms after the one before it. Every frame's JS is
  // 4 ms except the slow one's, 8 ms.
  const starts = [100_000, 110_000, 120_000, 130_000, 140_000, 165_000]
  const jsOf = (i: number) => (i === 5 ? 8_000 : 4_000)
  const frames = starts.flatMap((ts, i) => [
    raf(ts, jsOf(i)),
    // the runtime's wait ended 0.3 ms before the callback began
    xrEv('xrWaitFrame', ts - 3_300, 3_000),
    // submitted 0.5 ms after the callback ended, for 0.2 ms
    xrEv('xrEndFrame', ts + jsOf(i) + 500, 200),
    // the layer copy in the GPU process, 0.7 ms
    xrEv('CopySubTexture', ts + jsOf(i) + 1_000, 700, GPU, GPUMAIN, 'gpu'),
  ])

  it('picks wait, submit and copy from the census and reads each column', () => {
    const r = reduceFrameTrace([...xrMeta, ...frames])
    expect(r.xrPicks.wait?.names).toEqual(['xrWaitFrame'])
    expect(r.xrPicks.submit?.names).toEqual(['xrEndFrame'])
    expect(r.xrPicks.copy?.names).toEqual(['CopySubTexture'])
    const f = r.frames[0] as FrameRow
    expect(f.xrWait).toBeCloseTo(3, 6)
    expect(f.xrWaitToRaf).toBeCloseTo(0.3, 6)
    expect(f.xrSubmitStart).toBeCloseTo(4.5, 6)
    expect(f.xrSubmitAfterJs).toBeCloseTo(0.5, 6)
    expect(f.xrSubmitDur).toBeCloseTo(0.2, 6)
    expect(f.xrCopy).toBeCloseTo(0.7, 6)
    // With XR submits present, they ARE the present.
    expect(r.presentKind).toBe('xrEndFrame')
    expect(f.presentEnd).toBeCloseTo(4.7, 6)
  })

  it('says nothing matched, rather than guessing, when the trace has no XR events', () => {
    const r = reduceFrameTrace([...meta, ...starts.map((ts) => raf(ts, 4_000))])
    expect(r.xrPicks).toEqual({ wait: null, submit: null, copy: null })
    expect((r.frames[0] as FrameRow).xrWait).toBeNull()
  })

  it('compares slow frames with the rest, column by column', () => {
    const r = reduceFrameTrace([...xrMeta, ...frames])
    expect(r.medianPeriod).toBeCloseTo(10, 6)
    expect(r.slowCount).toBe(1)
    const js = r.slowVsFast.find((c) => c.column === 'js')
    expect(js?.fast).toBeCloseTo(4, 6)
    expect(js?.slow).toBeCloseTo(8, 6)
    expect(js?.delta).toBeCloseTo(4, 6)
  })

  it('names what held the GPU process while a flush waited, by self time', () => {
    // A flush at 12 000 starts in the GPU process at 13 500 (1.5 ms wait). In between its main
    // thread ran a task of 0.8 ms of which a child took 0.5 ms.
    const base = [
      ...meta,
      raf(10_000, 5_000),
      rflush(12_000, 1),
      gflush(13_500, 300, 1),
      {
        ph: 'X',
        name: 'ThreadControllerImpl::RunTask',
        cat: 'toplevel',
        pid: GPU,
        tid: GPUMAIN,
        ts: 12_200,
        dur: 800,
      },
      { ph: 'X', name: 'HeldIt', cat: 'gpu', pid: GPU, tid: GPUMAIN, ts: 12_300, dur: 500 },
      raf(20_000, 4_000),
    ]
    const r = reduceFrameTrace(base)
    expect(r.queueIntervals).toBe(1)
    expect(r.queueCulprits[0]?.name).toBe('HeldIt')
    expect(r.queueCulprits[0]?.ms).toBeCloseTo(0.5, 6)
    expect(r.queueCulprits[1]?.name).toBe('ThreadControllerImpl::RunTask')
    expect(r.queueCulprits[1]?.ms).toBeCloseTo(0.3, 6)
  })
})

describe('trace-frame reducer, the XR frame chain on a worn trace (DEV-993)', () => {
  // The shape of a worn frame, 2026-10-15: the renderer's ExecuteRAFCallbacks is the frame
  // (the bundle is minified, so no function is called onAnimationFrame), its SubmitFrame goes to
  // the XR service's SubmitFrameWithTextureHandle, whose GraphicsBinding Render blocks in
  // GLES2::Finish on the GPU process's XRCompositing, then xrEndFrame, then the next wait.
  const XR = 300
  const XRTID = 7
  const x = (name: string, ts: number, dur: number, pid: number, tid: number, cat = 'xr') => ({
    ph: 'X',
    name,
    cat,
    pid,
    tid,
    ts,
    dur,
  })
  const base = [
    ...meta,
    {
      ph: 'M',
      name: 'process_name',
      pid: XR,
      args: { name: 'Service: device.mojom.XRDeviceService' },
    },
    { ph: 'M', name: 'thread_name', pid: XR, tid: XRTID, args: { name: 'OpenXrRenderLoop' } },
    x('ExecuteRAFCallbacks', 100_000, 3_000, RENDERER, MAIN),
    x('ExecuteRAFCallbacks', 114_000, 3_000, RENDERER, MAIN),
    x('xrWaitFrame', 95_000, 4_800, XR, XRTID),
    x('XRFrameProvider::SubmitFrame', 103_400, 200, RENDERER, MAIN, 'gpu'),
    x('OpenXrRenderLoop::SubmitFrameWithTextureHandle', 103_800, 9_000, XR, XRTID),
    x('SetSourceTexture', 103_850, 150, XR, XRTID),
    x('GraphicsBinding Render', 104_100, 3_500, XR, XRTID),
    x('GLES2::Finish', 104_150, 3_400, XR, XRTID, 'gpu'),
    x('xrEndFrame', 107_700, 900, XR, XRTID),
    x('xrWaitFrame', 108_700, 4_500, XR, XRTID),
    // the GPU process's main thread: a flush (so the thread is known), our WebGL work (1 ms of
    // which 0.8 is a child), and XRCompositing (2 ms, 1.9 of it a child)
    gflush(100_900, 50, 1),
    x('WebGL', 101_000, 1_000, GPU, GPUMAIN, 'gpu'),
    x('CommandBufferService:PutChanged', 101_050, 800, GPU, GPUMAIN, 'gpu'),
    x('XRCompositing', 105_000, 2_000, GPU, GPUMAIN, 'gpu'),
    x('CommandBufferService:PutChanged', 105_050, 1_900, GPU, GPUMAIN, 'gpu'),
  ]

  it('takes ExecuteRAFCallbacks as the frame when the bundle has no readable function name', () => {
    const r = reduceFrameTrace(base)
    expect(r.rafKind).toBe('ExecuteRAFCallbacks')
    expect(r.rendererPid).toBe(RENDERER)
    expect(r.frames.length).toBe(2)
    expect((r.frames[0] as FrameRow).js).toBeCloseTo(3, 6)
  })

  it('joins the XR chain to the frame, step by step', () => {
    const f = reduceFrameTrace(base).frames[0] as FrameRow
    expect(f.xrSubFrame).toBeCloseTo(3.4, 6)
    expect(f.xrMojoHop).toBeCloseTo(0.4, 6)
    expect(f.xrHandleStart).toBeCloseTo(3.8, 6)
    expect(f.xrHandleDur).toBeCloseTo(9, 6)
    expect(f.xrSetSourceDur).toBeCloseTo(0.15, 6)
    expect(f.xrRenderStart).toBeCloseTo(4.1, 6)
    expect(f.xrRenderDur).toBeCloseTo(3.5, 6)
    expect(f.xrFinishDur).toBeCloseTo(3.4, 6)
    expect(f.xrCompStart).toBeCloseTo(5, 6)
    expect(f.xrCompDur).toBeCloseTo(2, 6)
    expect(f.xrRenderEndToEndFrame).toBeCloseTo(0.1, 6)
    expect(f.xrNextWaitStart).toBeCloseTo(8.7, 6)
    expect(f.xrNextWaitDur).toBeCloseTo(4.5, 6)
    // the wait BEFORE this callback ended 0.2 ms ahead of it
    expect(f.xrWait).toBeCloseTo(4.8, 6)
    expect(f.xrWaitToRaf).toBeCloseTo(0.2, 6)
  })

  it('splits the GPU main thread into what its time is for, children inheriting the parent', () => {
    const f = reduceFrameTrace(base).frames[0] as FrameRow
    expect(f.gpuMain_webgl).toBeCloseTo(1, 6)
    expect(f.gpuMain_xrComposite).toBeCloseTo(2, 6)
    expect(f.gpuMain_other).toBeCloseTo(0.05, 6)
    expect(f.gpuMainBusy).toBeCloseTo(3.05, 6)
  })

  it('leaves the chain null, not zero, when the trace has none of it', () => {
    const f = reduceFrameTrace([...meta, raf(10_000, 3_000), raf(20_000, 3_000)])
      .frames[0] as FrameRow
    expect(f.xrCompDur).toBeNull()
    expect(f.xrRenderDur).toBeNull()
    expect(f.gpuMainBusy).toBeUndefined()
  })

  it('the loader keeps the frame and the chain whatever their category', () => {
    for (const name of [
      'ExecuteRAFCallbacks',
      'XRFrameProvider::SubmitFrame',
      'GLES2::Finish',
      'XRCompositing',
    ])
      expect(keepEvent({ ph: 'X', name, cat: 'gpu', pid: 1, tid: 1, dur: 1 }, 9, 9)).toBe(true)
  })
})
