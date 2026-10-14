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

  // rAF callbacks: three's onAnimationFrame, else FireAnimationFrame.
  const isRaf = (e) =>
    e.ph === 'X' && e.name === 'FunctionCall' && e.args?.data?.functionName === 'onAnimationFrame'
  let rafs = events.filter(isRaf)
  let rafKind = 'onAnimationFrame'
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

  // Presents.
  const isPresent = (e) => {
    if (e.ph !== 'X') return false
    if (FLAT_PRESENT.includes(e.name)) return true
    return XR_SUBMIT.some((re) => re.test(e.name)) && /xr|gpu/i.test(String(e.cat))
  }
  const presents = events
    .filter((e) => isPresent(e) && (e.pid === gpuPid || e.cat?.includes('xr')))
    .sort((a, b) => a.ts - b.ts)
  const presentKind = presents[0]?.name ?? null

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
    frames.push({
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
  const summary = {}
  for (const c of cols) summary[c] = stat(frames.map((f) => f[c]))
  return {
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
  return out.join('\n')
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
  const reduced = reduceFrameTrace(JSON.parse(fs.readFileSync(file, 'utf8')))
  const table = renderFrameTable(reduced)
  if (process.argv[3]) fs.writeFileSync(process.argv[3], table)
  console.log(table)
}
