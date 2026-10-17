// tools/perf/trace-frame.mjs: reduce a Chrome trace to a per-frame critical path. DEV-970.
//
//   node --max-old-space-size=8192 tools/perf/trace-frame.mjs <chrome-trace.json> [out.md]
//
// Input is the JSON Chrome writes (`{ traceEvents: [...] }` or the bare array), taken by
// `tests/e2e/fixtures/chrome-trace.ts`. Output is one row per rAF callback of the game's
// page, every time relative to that callback's start, in milliseconds.
//
// What a row means, in the order the work happens:
//
//   rAF start       the frame's callback begins on the renderer's main thread. Found as
//                   the V8 `FunctionCall` whose function is three's `onAnimationFrame`
//                   (flat AND XR: both go through it), falling back to
//                   `FireAnimationFrame`.
//   js              the callback's duration: our JS, `frame()` and the draw recording.
//   flushes         `CommandBufferProxyImpl::Flush` on that thread between this callback's
//                   start and the next one's: the points where the recorded WebGL commands
//                   leave the renderer. Count, and where the first and last fall.
//   queue           for each flush, the time from the renderer sending it to the GPU
//                   process starting it (`CommandBufferStub::OnAsyncFlush`, matched by
//                   `put_offset`). The GPU process's main thread is shared with the
//                   display compositor and raster, so this is where a frame waits behind
//                   somebody else. Worst of the frame's flushes.
//   gpu start/end   the first flush's start in the GPU process, and the end of the last
//                   one's GPU execution (the `WebGL-0x..` async slice the GPU service
//                   emits around each flush's commands; it ends when the timer query for
//                   them resolves).
//   gpu tail        how much GPU execution is still outstanding when our JS has ended.
//                   Submit-early (`?submit=flush`) exists to shrink this.
//   present         the swap: the first `DCompPresenter::Present` / swapchain present on
//                   or after the JS end (flat), or the XR submit events (see `XR_SUBMIT`).
//   gap             present start minus the later of JS end and GPU end: time after all of
//                   OUR work is done during which the frame is not yet swapped. The gap
//                   nobody owns.
//
// What this does not do: attribute the time inside the gap to a cause. It names the
// neighbours (what the GPU thread was running, via `gapCensus`) so a person can.

/** Names that mark an XR frame's submit to the runtime. Unverified on this box: the
 * rig run prints `xrCensus` (every event in category `xr`) so these can be corrected. */
export const XR_SUBMIT = [
  /OpenXr.*(End|Submit)/i,
  /XRFrameTransport.*Submit/i,
  /SubmitFrame/i,
  /xrEndFrame/i,
]

/**
 * Event-name patterns per role in an XR frame, most specific first. The reducer scans the
 * trace for each role in this order and uses the first pattern that matches anything; it
 * reports which names that was (`xrPicks`) so a reader can check the choice against the
 * census rather than trust it. Written before any worn trace existed (DEV-993): correct the
 * lists from the census of the first real one.
 *
 *   wait    the runtime blocking the app until it is time to render (xrWaitFrame).
 *   submit  the app's frame going to the runtime (xrEndFrame, the frame transport's submit).
 *   copy    the GPU process copying the layer into the runtime's swapchain.
 */
export const XR_ROLES = {
  wait: [/xrWaitFrame/i, /WaitForNextFrame|WaitForFrame|WaitFrame/i],
  submit: [/xrEndFrame/i, /XRFrameTransport.*Submit|SubmitFrame/i, /OpenXr.*(End|Submit)/i],
  copy: [/CopyTexture|CopySubTexture|ResolveFramebuffer|Blit|CopyToSwapChain/i],
}
const ROLE_RES = Object.values(XR_ROLES).flat()
const XRISH_CAT = /(^|,)(disabled-by-default-)?(xr|openxr|vr)(,|$)/i
/**
 * The XR frame's chain, by event name (Chrome 153, SteamVR; verified on a worn trace 2026-10-15):
 * the renderer's SubmitFrame, the XR device service's SubmitFrameWithTextureHandle on its
 * OpenXrRenderLoop thread (SetSourceTexture, CompositeAndSubmit > GraphicsBinding Render >
 * GLES2::Finish, then xrEndFrame, then the NEXT frame's GetNextFrameData > xrWaitFrame), and the
 * GPU process's XRCompositing. Kept by the loader whatever their category.
 */
export const XR_CHAIN = [
  'XRFrameProvider::SubmitFrame',
  'XRFrameTransport::CopyImage',
  'OpenXrRenderLoop::SubmitFrameWithTextureHandle',
  'SetSourceTexture',
  'CompositeAndSubmit',
  'GraphicsBinding Render',
  'GLES2::Finish',
  'CommandBufferProxyImpl::WaitForGetOffset',
  'XRCompositing',
]

/** What the GPU process's main thread's time is FOR, by the nearest ancestor that says. */
const GPU_BUCKETS = [
  ['xrComposite', /^XRCompositing$/],
  ['webgl', /^WebGL$/],
  ['raster', /RendererRasterWorker|RasterDecoder/],
  [
    'present',
    /DXGISwapChainImageBacking::Present|DCompPresenter|^Graphics\.Pipeline$|ScheduleOverlays/,
  ],
  ['viz', /SkiaOutputSurfaceImplOnGpu|SkiaRenderer/],
  ['d3d', /D3DImageBacking|DXGISharedHandleState/],
]
export const GPU_BUCKET_NAMES = [...GPU_BUCKETS.map(([n]) => n), 'other']
export const FLAT_PRESENT = ['DCompPresenter::Present', 'DXGISwapChainImageBacking::Present']

const ms = (us) => us / 1000

const pct = (sorted, p) => {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/** p50, p95, max of the finite numbers in `xs`, or nulls. */
export const stat = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return {
    n: v.length,
    p50: pct(v, 0.5),
    p95: pct(v, 0.95),
    max: v.length ? v[v.length - 1] : null,
  }
}

/** Index of the first element of sorted `arr` whose `key` is >= `x`. */
const lowerBound = (arr, x, key) => {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (key(arr[mid]) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const reduceFrameTrace = (input, opts = {}) => {
  const events = Array.isArray(input) ? input : (input.traceEvents ?? [])
  const procName = new Map()
  const threadName = new Map()
  for (const e of events) {
    if (e.ph !== 'M') continue
    if (e.name === 'process_name') procName.set(e.pid, e.args?.name)
    else if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name)
  }
  const gpuPid = [...procName].find(([, n]) => n === 'GPU Process')?.[0] ?? null

  // rAF callbacks. In an XR session the renderer's own `ExecuteRAFCallbacks` (category xr) is the
  // frame: it exists whatever the bundle is called. A flat page has none, so three's
  // `onAnimationFrame` is looked for by name (a MINIFIED build renames it, which is why a worn
  // production trace found no frames: DEV-993), then `FireAnimationFrame`.
  const isRaf = (e) =>
    e.ph === 'X' && e.name === 'FunctionCall' && e.args?.data?.functionName === 'onAnimationFrame'
  let rafs = events.filter((e) => e.ph === 'X' && e.name === 'ExecuteRAFCallbacks')
  let rafKind = 'ExecuteRAFCallbacks'
  if (rafs.length === 0) {
    rafs = events.filter(isRaf)
    rafKind = 'onAnimationFrame'
  }
  if (rafs.length === 0) {
    rafs = events.filter((e) => e.ph === 'X' && e.name === 'FireAnimationFrame')
    rafKind = 'FireAnimationFrame'
  }
  // The game's page is the renderer that fired the most of them.
  const byThread = new Map()
  for (const e of rafs)
    byThread.set(`${e.pid}:${e.tid}`, (byThread.get(`${e.pid}:${e.tid}`) ?? 0) + 1)
  const mainKey = [...byThread].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const rendererPid = mainKey === null ? null : Number(mainKey.split(':')[0])
  const mainTid = mainKey === null ? null : Number(mainKey.split(':')[1])
  rafs = rafs.filter((e) => e.pid === rendererPid && e.tid === mainTid).sort((a, b) => a.ts - b.ts)

  const from = opts.fromTs ?? -Infinity
  const to = opts.toTs ?? Infinity

  // Renderer flushes, GPU-process flushes by put_offset, GPU execution slices.
  const rFlush = events
    .filter(
      (e) =>
        e.ph === 'X' &&
        e.name === 'CommandBufferProxyImpl::Flush' &&
        e.pid === rendererPid &&
        e.tid === mainTid,
    )
    .sort((a, b) => a.ts - b.ts)
  const gFlushByPut = new Map()
  const gFlushAll = []
  const gpuSlices = new Map() // key -> [{b, e}]
  const open = new Map()
  const gpuEv = events.filter((e) => e.pid === gpuPid).sort((a, b) => a.ts - b.ts)
  for (const e of gpuEv) {
    if (e.ph === 'X' && e.name === 'CommandBufferStub::OnAsyncFlush') {
      const put = e.args?.put_offset
      const row = { ts: e.ts, end: e.ts + (e.dur ?? 0), put, used: false, execEnd: null }
      gFlushAll.push(row)
      if (!gFlushByPut.has(put)) gFlushByPut.set(put, [])
      gFlushByPut.get(put).push(row)
    } else if (
      (e.ph === 'b' || e.ph === 'e') &&
      typeof e.name === 'string' &&
      e.name.startsWith('WebGL-')
    ) {
      const key = `${e.name}:${e.id2?.local ?? e.id ?? ''}`
      if (e.ph === 'b') open.set(key, e.ts)
      else if (open.has(key)) {
        if (!gpuSlices.has('all')) gpuSlices.set('all', [])
        gpuSlices.get('all').push({ b: open.get(key), e: e.ts })
        open.delete(key)
      }
    }
  }
  const slices = (gpuSlices.get('all') ?? []).sort((a, b) => a.b - b.b)
  for (const g of gFlushAll) {
    const i = lowerBound(slices, g.ts, (s) => s.b)
    const s = slices[i]
    if (s && s.b <= g.end + 5) g.execEnd = s.e
  }

  // XR: census every event that is in an xr-ish category or matches a role pattern, so the
  // table can say what it picked and a reader can check it. Keyed process|thread|cat|name.
  const censusMap = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.name !== 'string') continue
    const catHit = typeof e.cat === 'string' && XRISH_CAT.test(e.cat)
    if (!catHit && !ROLE_RES.some((re) => re.test(e.name))) continue
    const key = `${procName.get(e.pid) ?? e.pid}|${threadName.get(`${e.pid}:${e.tid}`) ?? e.tid}|${e.cat}|${e.name}`
    let row = censusMap.get(key)
    if (!row) {
      row = {
        process: procName.get(e.pid) ?? String(e.pid),
        thread: threadName.get(`${e.pid}:${e.tid}`) ?? String(e.tid),
        cat: e.cat,
        name: e.name,
        n: 0,
        durs: [],
      }
      censusMap.set(key, row)
    }
    row.n++
    row.durs.push(e.dur ?? 0)
  }
  const xrEventCensus = [...censusMap.values()]
    .map((r) => {
      const d = r.durs.sort((a, b) => a - b)
      return {
        process: r.process,
        thread: r.thread,
        cat: r.cat,
        name: r.name,
        n: r.n,
        p50Ms: ms(d[Math.floor(d.length / 2)] ?? 0),
        totalMs: ms(d.reduce((a, b) => a + b, 0)),
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
  /** First pattern of the role matching any census name; its names, or null. */
  const pickRole = (role) => {
    const names = new Set(xrEventCensus.map((r) => r.name))
    for (const re of XR_ROLES[role]) {
      const hit = [...names].filter((n) => re.test(n))
      if (hit.length) return { pattern: String(re), names: new Set(hit) }
    }
    return null
  }
  const xrPicks = { wait: pickRole('wait'), submit: pickRole('submit'), copy: pickRole('copy') }
  const roleEvents = (role, gpuOnly) => {
    const pick = xrPicks[role]
    if (!pick) return []
    return events
      .filter((e) => e.ph === 'X' && pick.names.has(e.name) && (!gpuOnly || e.pid === gpuPid))
      .sort((a, b) => a.ts - b.ts)
  }
  const waitEvents = roleEvents('wait', false)
  const submitEvents = roleEvents('submit', false)
  const copyEvents = roleEvents('copy', true)

  // Presents: XR submits when the trace has them, else the flat swap.
  const isFlatPresent = (e) => e.ph === 'X' && FLAT_PRESENT.includes(e.name) && e.pid === gpuPid
  const presents =
    submitEvents.length > 0
      ? submitEvents
      : events.filter(isFlatPresent).sort((a, b) => a.ts - b.ts)
  const presentKind = presents[0]?.name ?? null

  // What the GPU process's main thread was doing while our flushes waited (self time, by
  // name). Built lazily below from the matched flushes.
  const gpuMainTid = gFlushAll.length
    ? (gpuEv.find((e) => e.ph === 'X' && e.name === 'CommandBufferStub::OnAsyncFlush')?.tid ?? null)
    : null

  // The GPU process's main thread as a tree: self time per event, and a bucket inherited from
  // the nearest ancestor that names one. (Tasks under 20 us are dropped by the loader, so a
  // parent's self time reads slightly high.)
  const tev =
    gpuMainTid === null
      ? []
      : gpuEv
          .filter((e) => e.ph === 'X' && e.tid === gpuMainTid)
          .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
  {
    const stack = []
    for (const e of tev) {
      e._end = e.ts + (e.dur ?? 0)
      e._self = e.dur ?? 0
      while (stack.length && stack[stack.length - 1]._end <= e.ts) stack.pop()
      const parent = stack[stack.length - 1]
      if (parent) parent._self -= e.dur ?? 0
      e._bucket = GPU_BUCKETS.find(([, re]) => re.test(e.name))?.[0] ?? parent?._bucket ?? 'other'
      stack.push(e)
    }
  }

  // XR chain events by name, sorted.
  const chain = {}
  for (const n of XR_CHAIN) chain[n] = []
  for (const e of events) if (e.ph === 'X' && chain[e.name]) chain[e.name].push(e)
  for (const n of XR_CHAIN) chain[n].sort((a, b) => a.ts - b.ts)
  const firstFrom = (arr, ts, limit = Infinity) => {
    const e = arr[lowerBound(arr, ts, (x) => x.ts)]
    return e && e.ts < limit ? e : null
  }

  // Flush -> GPU start matching, once, in order.
  const matched = new Map() // rFlush row -> g
  for (const r of rFlush) {
    const cands = gFlushByPut.get(r.args?.put_offset)
    if (!cands) continue
    const i = lowerBound(cands, r.ts - 50, (c) => c.ts)
    for (let k = i; k < cands.length; k++) {
      if (!cands[k].used) {
        cands[k].used = true
        matched.set(r, cands[k])
        break
      }
    }
  }

  const frames = []
  let presentCursor = 0
  for (let i = 0; i < rafs.length; i++) {
    const raf = rafs[i]
    if (raf.ts < from || raf.ts > to) continue
    const next = rafs[i + 1]
    const winEnd = next ? next.ts : raf.ts + (raf.dur ?? 0) + 16000
    const jsEnd = raf.ts + (raf.dur ?? 0)
    const f0 = lowerBound(rFlush, raf.ts, (r) => r.ts)
    const flushes = []
    for (let k = f0; k < rFlush.length && rFlush[k].ts < winEnd; k++) flushes.push(rFlush[k])
    const gs = flushes.map((r) => matched.get(r)).filter(Boolean)
    const queue = flushes
      .map((r) => (matched.get(r) ? matched.get(r).ts - r.ts : null))
      .filter((x) => x !== null)
    const execEnds = gs.map((g) => g.execEnd ?? g.end)
    const gpuStart = gs.length ? Math.min(...gs.map((g) => g.ts)) : null
    const gpuEnd = execEnds.length ? Math.max(...execEnds) : null
    const lastFlush = flushes.length ? flushes[flushes.length - 1] : null
    // Present: first on or after the JS end, never reusing an earlier frame's.
    const pi = Math.max(
      presentCursor,
      lowerBound(presents, jsEnd, (p) => p.ts),
    )
    const present = presents[pi] ?? null
    if (present) presentCursor = pi + 1
    const presentStart = present ? present.ts : null
    const ownEnd = Math.max(jsEnd, gpuEnd ?? jsEnd)
    // XR: the last wait that ended just before this callback, the first submit after its
    // start, and the layer copies inside the frame's window.
    let waitDur = null
    let waitEndToRaf = null
    if (waitEvents.length) {
      let k = lowerBound(waitEvents, raf.ts + 500, (w) => w.ts) - 1
      while (k >= 0 && waitEvents[k].ts + (waitEvents[k].dur ?? 0) > raf.ts + 500) k--
      const w = k >= 0 ? waitEvents[k] : null
      if (w && raf.ts - (w.ts + (w.dur ?? 0)) < 8000) {
        waitDur = ms(w.dur ?? 0)
        waitEndToRaf = ms(raf.ts - (w.ts + (w.dur ?? 0)))
      }
    }
    let submitStart = null
    let submitDur = null
    if (submitEvents.length) {
      const s = submitEvents[lowerBound(submitEvents, raf.ts, (x) => x.ts)]
      if (s && s.ts < winEnd + 4000) {
        submitStart = ms(s.ts - raf.ts)
        submitDur = ms(s.dur ?? 0)
      }
    }
    let copyMs = null
    if (copyEvents.length) {
      let sum = 0
      for (
        let k = lowerBound(copyEvents, raf.ts, (x) => x.ts);
        k < copyEvents.length && copyEvents[k].ts < winEnd;
        k++
      )
        sum += copyEvents[k].dur ?? 0
      copyMs = ms(sum)
    }
    // The XR chain: this frame's renderer SubmitFrame, the XR service's handle task, its
    // SetSourceTexture and GraphicsBinding Render (with the Finish inside it), the GPU
    // process's XRCompositing, xrEndFrame, and the wait that follows it.
    const rel = (e) => (e ? ms(e.ts - raf.ts) : null)
    const dur = (e) => (e ? ms(e.dur ?? 0) : null)
    const sf = firstFrom(chain['XRFrameProvider::SubmitFrame'], raf.ts, winEnd)
    const hd = firstFrom(
      chain['OpenXrRenderLoop::SubmitFrameWithTextureHandle'],
      sf ? sf.ts : raf.ts,
      winEnd + 4000,
    )
    const ss = hd ? firstFrom(chain.SetSourceTexture, hd.ts) : null
    const rd = hd ? firstFrom(chain['GraphicsBinding Render'], hd.ts) : null
    const fin = rd ? firstFrom(chain['GLES2::Finish'], rd.ts, rd.ts + (rd.dur ?? 0)) : null
    const wgo = rd
      ? firstFrom(chain['CommandBufferProxyImpl::WaitForGetOffset'], rd.ts, rd.ts + (rd.dur ?? 0))
      : null
    const comp = rd ? firstFrom(chain.XRCompositing, rd.ts) : null
    const endF = rd ? firstFrom(submitEvents, rd.ts) : null
    const nextWait = endF ? firstFrom(waitEvents, endF.ts + (endF.dur ?? 0)) : null
    const buckets = {}
    if (tev.length) {
      for (const n of GPU_BUCKET_NAMES) buckets[`gpuMain_${n}`] = 0
      let busy = 0
      for (
        let k = lowerBound(tev, raf.ts, (x) => x.ts);
        k < tev.length && tev[k].ts < winEnd;
        k++
      ) {
        if (tev[k]._self > 0) {
          buckets[`gpuMain_${tev[k]._bucket}`] += tev[k]._self
          busy += tev[k]._self
        }
      }
      for (const k of Object.keys(buckets)) buckets[k] = ms(buckets[k])
      buckets.gpuMainBusy = ms(busy)
    }
    frames.push({
      ...buckets,
      xrSubFrame: rel(sf),
      xrMojoHop: sf && hd ? ms(hd.ts - sf.ts) : null,
      xrHandleStart: rel(hd),
      xrHandleDur: dur(hd),
      xrSetSourceDur: dur(ss),
      xrRenderStart: rel(rd),
      xrRenderDur: dur(rd),
      xrFinishDur: dur(fin),
      xrWaitForGetOffset: dur(wgo),
      xrCompStart: rel(comp),
      xrCompDur: dur(comp),
      xrRenderEndToEndFrame: rd && endF ? ms(endF.ts - (rd.ts + (rd.dur ?? 0))) : null,
      xrNextWaitStart: rel(nextWait),
      xrNextWaitDur: dur(nextWait),
      xrWait: waitDur,
      xrWaitToRaf: waitEndToRaf,
      xrSubmitStart: submitStart,
      xrSubmitDur: submitDur,
      xrSubmitAfterJs: submitStart === null ? null : submitStart - ms(raf.dur ?? 0),
      xrCopy: copyMs,
      index: frames.length,
      rafStart: ms(raf.ts),
      period: i > 0 ? ms(raf.ts - rafs[i - 1].ts) : null,
      js: ms(raf.dur ?? 0),
      flushes: flushes.length,
      firstFlush: flushes.length ? ms(flushes[0].ts - raf.ts) : null,
      lastFlush: lastFlush ? ms(lastFlush.ts - raf.ts) : null,
      lastFlushAfterJs: lastFlush ? ms(lastFlush.ts - jsEnd) : null,
      queueMax: queue.length ? ms(Math.max(...queue)) : null,
      queueSum: queue.length ? ms(queue.reduce((a, b) => a + b, 0)) : null,
      gpuStart: gpuStart === null ? null : ms(gpuStart - raf.ts),
      gpuEnd: gpuEnd === null ? null : ms(gpuEnd - raf.ts),
      gpuTail: gpuEnd === null ? null : ms(Math.max(0, gpuEnd - jsEnd)),
      presentEnd: present ? ms(present.ts + (present.dur ?? 0) - raf.ts) : null,
      gap: presentStart === null ? null : ms(Math.max(0, presentStart - ownEnd)),
    })
  }

  const xrCensus = {}
  for (const e of events) {
    if (typeof e.cat === 'string' && /(^|,)xr(,|$)/.test(e.cat))
      xrCensus[e.name] = (xrCensus[e.name] ?? 0) + 1
  }

  const cols = [
    'period',
    'js',
    'flushes',
    'firstFlush',
    'lastFlush',
    'lastFlushAfterJs',
    'queueMax',
    'queueSum',
    'gpuStart',
    'gpuEnd',
    'gpuTail',
    'presentEnd',
    'gap',
  ]
  const xrCols = [
    'xrWait',
    'xrWaitToRaf',
    'xrSubmitStart',
    'xrSubmitDur',
    'xrSubmitAfterJs',
    'xrCopy',
  ]
  xrCols.push(
    'xrSubFrame',
    'xrMojoHop',
    'xrHandleStart',
    'xrHandleDur',
    'xrSetSourceDur',
    'xrRenderStart',
    'xrRenderDur',
    'xrFinishDur',
    'xrWaitForGetOffset',
    'xrCompStart',
    'xrCompDur',
    'xrRenderEndToEndFrame',
    'xrNextWaitStart',
    'xrNextWaitDur',
    'gpuMainBusy',
    ...GPU_BUCKET_NAMES.map((n) => `gpuMain_${n}`),
  )
  for (const c of xrCols) if (frames.some((f) => f[c] !== null && f[c] !== undefined)) cols.push(c)
  const summary = {}
  for (const c of cols) summary[c] = stat(frames.map((f) => f[c]))

  // Slow frames against the rest: a frame is slow when its period is over 1.5 x the median.
  // The delta column is where the missing milliseconds are.
  const periods = frames.map((f) => f.period).filter((p) => p !== null)
  const medianPeriod = stat(periods).p50
  const isSlow = (f) => medianPeriod !== null && f.period !== null && f.period > 1.5 * medianPeriod
  const slowFrames = frames.filter(isSlow)
  const fastFrames = frames.filter((f) => f.period !== null && !isSlow(f))
  const slowVsFast = cols
    .filter((c) => c !== 'period')
    .map((c) => {
      const fast = stat(fastFrames.map((f) => f[c])).p50
      const slow = stat(slowFrames.map((f) => f[c])).p50
      return { column: c, fast, slow, delta: fast !== null && slow !== null ? slow - fast : null }
    })
  const missRate = periods.length ? slowFrames.length / periods.length : null

  // Who held the GPU process's main thread while a flush waited more than 1 ms: self time of
  // every event on it, apportioned by overlap with the waiting interval.
  const queueCulprits = []
  const queueBuckets = []
  let queueIntervals = 0
  if (gpuMainTid !== null) {
    const byName = new Map()
    const byBucket = new Map()
    for (const [r, g] of matched) {
      if (g.ts - r.ts <= 1000) continue
      queueIntervals++
      const a = r.ts
      const b = g.ts
      for (let k = lowerBound(tev, a - 20000, (x) => x.ts); k < tev.length && tev[k].ts < b; k++) {
        const e = tev[k]
        const ov = Math.min(e._end, b) - Math.max(e.ts, a)
        if (ov <= 0 || !(e._self > 0) || !(e.dur > 0)) continue
        byName.set(e.name, (byName.get(e.name) ?? 0) + e._self * (ov / e.dur))
        byBucket.set(e._bucket, (byBucket.get(e._bucket) ?? 0) + e._self * (ov / e.dur))
      }
    }
    const total = [...byName.values()].reduce((x, y) => x + y, 0)
    for (const [name, us] of [...byName].sort((x, y) => y[1] - x[1]).slice(0, 12))
      queueCulprits.push({ name, ms: ms(us), share: total ? us / total : 0 })
    for (const [bucket, us] of [...byBucket].sort((x, y) => y[1] - x[1]))
      queueBuckets.push({ bucket, ms: ms(us), share: total ? us / total : 0 })
  }
  const describePick = (p) => (p ? { pattern: p.pattern, names: [...p.names].slice(0, 12) } : null)
  return {
    xrPicks: {
      wait: describePick(xrPicks.wait),
      submit: describePick(xrPicks.submit),
      copy: describePick(xrPicks.copy),
    },
    xrEventCensus: xrEventCensus.slice(0, 60),
    medianPeriod,
    missRate,
    slowCount: slowFrames.length,
    slowVsFast,
    queueCulprits,
    queueBuckets,
    queueIntervals,
    rendererPid,
    gpuPid,
    rafKind,
    presentKind,
    flushesMatched: matched.size,
    flushesSeen: rFlush.length,
    summary,
    xrCensus,
    frames,
  }
}

const f2 = (x) => (x === null || x === undefined ? '    -' : x.toFixed(2).padStart(7))

/** The reduced table as markdown: the summary rows, then the worst frames by period. */
export const renderFrameTable = (r) => {
  const out = []
  out.push(
    `frames ${r.frames.length}; rAF found as ${r.rafKind}; present as ${r.presentKind ?? 'none'}; renderer pid ${r.rendererPid}, GPU pid ${r.gpuPid}; flushes matched to the GPU process ${r.flushesMatched} of ${r.flushesSeen}`,
  )
  out.push('')
  out.push('| column (ms, from rAF start unless noted) | p50 | p95 | max |')
  out.push('|---|---|---|---|')
  const label = {
    period: 'period (rAF to rAF)',
    js: 'js (our callback)',
    flushes: 'renderer flushes per frame (count)',
    firstFlush: 'first flush',
    lastFlush: 'last flush',
    lastFlushAfterJs: 'last flush, relative to JS end',
    queueMax: 'flush to GPU-process start, worst of frame',
    queueSum: 'flush to GPU-process start, summed',
    gpuStart: 'GPU process starts our commands',
    gpuEnd: 'our GPU execution ends',
    gpuTail: 'GPU execution outstanding after JS ends',
    presentEnd: 'present ends',
    gap: 'gap: present start after all our work',
    xrWait: 'XR wait (xrWaitFrame) duration',
    xrWaitToRaf: 'XR wait end to our callback start',
    xrSubmitStart: 'XR submit starts',
    xrSubmitDur: 'XR submit duration',
    xrSubmitAfterJs: 'XR submit start after JS end',
    xrCopy: 'GPU-process layer copy / blit, summed in the frame',
    xrSubFrame: 'renderer XRFrameProvider::SubmitFrame starts',
    xrMojoHop: 'SubmitFrame to the XR service starting its task',
    xrHandleStart: 'XR service SubmitFrameWithTextureHandle starts',
    xrHandleDur: 'XR service SubmitFrameWithTextureHandle duration (holds the next wait too)',
    xrSetSourceDur: 'SetSourceTexture duration',
    xrRenderStart: 'GraphicsBinding Render starts',
    xrRenderDur: 'GraphicsBinding Render duration',
    xrFinishDur: 'GLES2::Finish inside Render (XR thread blocked on the GPU process)',
    xrWaitForGetOffset: 'WaitForGetOffset inside it',
    xrCompStart: 'GPU process XRCompositing starts',
    xrCompDur: 'GPU process XRCompositing duration',
    xrRenderEndToEndFrame: 'Render end to xrEndFrame start',
    xrNextWaitStart: 'next xrWaitFrame starts',
    xrNextWaitDur: 'next xrWaitFrame duration',
    gpuMainBusy: 'GPU process main thread busy in the frame (self time)',
    gpuMain_xrComposite: 'GPU main thread: XRCompositing',
    gpuMain_webgl: 'GPU main thread: our WebGL commands',
    gpuMain_raster: 'GPU main thread: raster (HUD canvas, page)',
    gpuMain_present: 'GPU main thread: DXGI / DComp present',
    gpuMain_viz: 'GPU main thread: viz / Skia',
    gpuMain_d3d: 'GPU main thread: D3D image access / keyed mutex',
    gpuMain_other: 'GPU main thread: other',
  }
  for (const [c, s] of Object.entries(r.summary)) {
    out.push(`| ${label[c] ?? c} | ${f2(s.p50)} | ${f2(s.p95)} | ${f2(s.max)} |`)
  }
  const worst = [...r.frames]
    .filter((f) => f.period !== null)
    .sort((a, b) => b.period - a.period)
    .slice(0, 8)
  out.push('')
  out.push('Worst eight frames by period:')
  out.push('')
  out.push(
    '| # | period | js | flushes | lastFlush | queueMax | gpuEnd | gpuTail | presentEnd | gap |',
  )
  out.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const f of worst) {
    out.push(
      `| ${f.index} | ${f2(f.period)} | ${f2(f.js)} | ${f.flushes} | ${f2(f.lastFlush)} | ${f2(f.queueMax)} | ${f2(f.gpuEnd)} | ${f2(f.gpuTail)} | ${f2(f.presentEnd)} | ${f2(f.gap)} |`,
    )
  }
  out.push('')
  if (r.slowVsFast?.length) {
    out.push(
      `Slow frames (period over 1.5 x the median ${f2(r.medianPeriod).trim()} ms): ${r.slowCount} of ${r.frames.length}, ${((r.missRate ?? 0) * 100).toFixed(1)} %. p50 of each column, fast against slow:`,
    )
    out.push('')
    out.push('| column | fast p50 | slow p50 | slow minus fast |')
    out.push('|---|---|---|---|')
    for (const c of r.slowVsFast) {
      out.push(
        `| ${label[c.column] ?? c.column} | ${f2(c.fast)} | ${f2(c.slow)} | ${f2(c.delta)} |`,
      )
    }
    out.push('')
  }
  if (r.queueCulprits?.length) {
    out.push(
      `What held the GPU process's main thread while our flushes waited over 1 ms (${r.queueIntervals} waits; self time, apportioned):`,
    )
    out.push('')
    out.push('| event | ms | share |')
    out.push('|---|---|---|')
    for (const b of r.queueBuckets ?? []) {
      out.push(`| (bucket) ${b.bucket} | ${f2(b.ms)} | ${(b.share * 100).toFixed(0)} % |`)
    }
    for (const c of r.queueCulprits) {
      out.push(`| ${c.name} | ${f2(c.ms)} | ${(c.share * 100).toFixed(0)} % |`)
    }
    out.push('')
  }
  out.push('XR roles picked from the census (check these against the list below):')
  out.push('')
  for (const role of ['wait', 'submit', 'copy']) {
    const pk = r.xrPicks?.[role]
    out.push(`- ${role}: ${pk ? `${pk.pattern} -> ${pk.names.join(', ')}` : 'nothing matched'}`)
  }
  out.push('')
  if (r.xrEventCensus?.length) {
    out.push('XR and role-matching events by total time:')
    out.push('')
    out.push('| process | thread | cat | name | n | p50 ms | total ms |')
    out.push('|---|---|---|---|---|---|---|')
    for (const e of r.xrEventCensus.slice(0, 40)) {
      out.push(
        `| ${e.process} | ${e.thread} | ${e.cat} | ${e.name} | ${e.n} | ${f2(e.p50Ms)} | ${f2(e.totalMs)} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

/**
 * Call `onObject(text)` with the JSON text of each element of the trace's `traceEvents` array,
 * reading the file in chunks. A worn capture of 60 to 90 s is over a gigabyte, and Node cannot
 * hold that as one string (its limit is about 512 MB), so the file is never parsed whole.
 * Assumes the array is the first `[` in the file, which is how Chrome writes it.
 */
export const scanTraceObjects = async (file, onObject, chunkBytes = 16 * 1024 * 1024) => {
  const fs = await import('node:fs')
  const { StringDecoder } = await import('node:string_decoder')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(chunkBytes)
  const dec = new StringDecoder('utf8')
  let started = false
  let depth = 0
  let inStr = false
  let esc = false
  let pieces = []
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      const text = dec.write(buf.subarray(0, n))
      let seg = depth > 0 ? 0 : -1
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i)
        if (!started) {
          if (c === 91) started = true
          continue
        }
        if (inStr) {
          if (esc) esc = false
          else if (c === 92) esc = true
          else if (c === 34) inStr = false
          continue
        }
        if (c === 34) inStr = true
        else if (c === 123) {
          if (depth === 0) seg = i
          depth++
        } else if (c === 125) {
          depth--
          if (depth === 0) {
            pieces.push(text.slice(seg, i + 1))
            onObject(pieces.length === 1 ? pieces[0] : pieces.join(''))
            pieces = []
            seg = -1
          }
        } else if (c === 93 && depth === 0) {
          return
        }
      }
      if (depth > 0) pieces.push(text.slice(Math.max(seg, 0)))
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Load a trace file as the reducer's input without holding what it does not read. Two passes:
 * the first finds the process names and the GPU process's main thread (the one running
 * `CommandBufferStub::OnAsyncFlush`); the second keeps the metadata, the events the reducer
 * names, anything in an XR category or matching an XR role, and the GPU main thread's tasks
 * of 20 us or more (the queue-culprit attribution reads those).
 */
export const loadTraceFile = async (file) => {
  const names = new Map()
  let gpuPid = null
  let gpuMainTid = null
  await scanTraceObjects(file, (text) => {
    if (text.includes('"ph":"M"')) {
      const e = JSON.parse(text)
      if (e.ph === 'M' && e.name === 'process_name') {
        names.set(e.pid, e.args?.name)
        if (e.args?.name === 'GPU Process') gpuPid = e.pid
      }
    } else if (gpuMainTid === null && text.includes('CommandBufferStub::OnAsyncFlush')) {
      gpuMainTid = JSON.parse(text).tid
    }
  })
  const events = []
  await scanTraceObjects(file, (text) => {
    const e = JSON.parse(text)
    if (keepEvent(e, gpuPid, gpuMainTid)) events.push(e)
  })
  return events
}

/** True for every event `reduceFrameTrace` reads (and the GPU main thread's longer tasks). */
export const keepEvent = (e, gpuPid, gpuMainTid) => {
  if (e.ph === 'M') return true
  const name = e.name
  if (typeof name !== 'string') return false
  if (e.ph === 'b' || e.ph === 'e') return name.startsWith('WebGL-')
  if (e.ph !== 'X') return false
  if (name === 'FunctionCall') return e.args?.data?.functionName === 'onAnimationFrame'
  if (
    name === 'FireAnimationFrame' ||
    name === 'ExecuteRAFCallbacks' ||
    XR_CHAIN.includes(name) ||
    name === 'CommandBufferProxyImpl::Flush' ||
    name === 'CommandBufferStub::OnAsyncFlush' ||
    FLAT_PRESENT.includes(name)
  )
    return true
  if (typeof e.cat === 'string' && XRISH_CAT.test(e.cat)) return true
  if (ROLE_RES.some((re) => re.test(name))) return true
  return e.pid === gpuPid && e.tid === gpuMainTid && (e.dur ?? 0) >= 20
}

// CLI
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  const fs = await import('node:fs')
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node tools/perf/trace-frame.mjs <chrome-trace.json> [out.md]')
    process.exit(2)
  }
  const reduced = reduceFrameTrace(await loadTraceFile(file))
  const table = renderFrameTable(reduced)
  if (process.argv[3]) fs.writeFileSync(process.argv[3], table)
  console.log(table)
}
