// src/boot/gpu-timer.ts — how long the GPU spent on the frame we just asked for.
//
// DEV-118. `boot/perf-recorder.ts` records the WALL delta between frames, and
// on a monitor that is vsync: the recorder read 17.7 ms on int_01 with every
// Anniversary system on and 17.7 ms with each of them off in turn, because the
// compositor hands frames out at its own rate whatever the GPU did inside one.
// A cost cannot be ranked with that number. This brackets the frame's draws in
// `EXT_disjoint_timer_query_webgl2` and keeps the GPU's own elapsed time in a
// ring, so `stats()` answers "how many milliseconds of GPU per frame" — the
// number that moves when a system is switched off, and the one a Quest, which
// is GPU-bound before it is anything else, will care about.
//
// ── The protocol, and why the ring lags ──────────────────────────────────
//
// One query may be open at a time; its result is available a frame or two
// later; and a `GPU_DISJOINT_EXT` event (a clock change, a context switch)
// invalidates every query in flight. So each frame opens a query round the
// render, closes it, then walks the queue of earlier queries and harvests the
// ones that have landed, dropping the lot on a disjoint. The ring therefore
// runs a frame or two behind the recorder and misses a frame here and there,
// which is fine for a median and stated here so nobody lines the two rings up
// sample for sample.
//
// Disabled it costs one boolean. Enabled it costs two GL calls a frame and a
// short queue. `?perf=1` turns it on; a spec can call `__ff2.gpu.enable()`.
// Where the extension is missing — some headset browsers hide it —
// `supported` is false, `stats()` is empty, and nothing else changes.

/** The slice of a WebGL2 context this needs. Structural, so a test can fake it. */
export interface TimerGl {
  getExtension(name: string): unknown
  createQuery(): WebGLQuery | null
  deleteQuery(q: WebGLQuery | null): void
  beginQuery(target: number, q: WebGLQuery): void
  endQuery(target: number): void
  getQueryParameter(q: WebGLQuery, pname: number): unknown
  getParameter(pname: number): unknown
  readonly QUERY_RESULT_AVAILABLE: number
  readonly QUERY_RESULT: number
}

interface TimerExt {
  readonly TIME_ELAPSED_EXT: number
  readonly GPU_DISJOINT_EXT: number
}

export interface GpuStats {
  /** Samples in the ring. `0` until the first result lands. */
  readonly frames: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly maxMs: number
}

export interface GpuTimer {
  /** False where the extension is missing; every other method is then a no-op. */
  readonly supported: boolean
  readonly enabled: boolean
  enable(): void
  disable(): void
  /** Open the frame's query. Call immediately before the render. */
  begin(): void
  /** Close it and harvest what earlier frames left. Call immediately after. */
  end(): void
  /** Read the ring. Allocates; call at a panel's rate. */
  stats(): GpuStats
  /**
   * The newest HARVESTED result, ms. `NaN` until the first one lands.
   *
   * Free to read, so `boot/perf-trace.ts` can store it on every frame where
   * `stats()` — which sorts — would be far too expensive. It is the **lagged**
   * number this file's header warns about: on any given frame it is the result
   * of a frame one or two back, and on a frame where nothing landed it is the
   * same value as the frame before. Pair it with `harvested` to tell those
   * apart; never line it up with a wall time on the same row.
   */
  readonly last: number
  /**
   * How many results have landed since the timer was built. Monotonic.
   *
   * The freshness flag, as a counter rather than a boolean, because a boolean
   * would have to be consumed and a counter can be read by two things at once.
   * A reader that saw `harvested` advance since its own last look is holding a
   * new `last`; one that did not is holding a repeat. `reset()` empties the
   * ring and deliberately does NOT reset this — it counts the driver's answers,
   * not the ring's contents.
   */
  readonly harvested: number
  /** Empty the ring. */
  reset(): void
}

/** Samples kept. 3 s at 72 Hz, and the perf recorder's own window is 3 s. */
export const GPU_RING = 240

/** Queries in flight before the oldest is abandoned rather than waited on. */
const MAX_PENDING = 8

export const createGpuTimer = (gl: TimerGl): GpuTimer => {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null
  const supported = ext !== null
  let enabled = false
  const pending: WebGLQuery[] = []
  const ring = new Float32Array(GPU_RING)
  let head = 0
  let count = 0
  let open: WebGLQuery | null = null
  let last = Number.NaN
  let harvested = 0

  const push = (ms: number): void => {
    ring[head] = ms
    head = (head + 1) % GPU_RING
    if (count < GPU_RING) count++
    last = ms
    harvested += 1
  }

  const dropPending = (): void => {
    for (const q of pending) gl.deleteQuery(q)
    pending.length = 0
  }

  return {
    supported,
    get enabled() {
      return enabled
    },
    get last() {
      return last
    },
    get harvested() {
      return harvested
    },
    enable() {
      if (supported) enabled = true
    },
    disable() {
      enabled = false
      if (open) {
        // A query left open across a disable would be closed by nobody.
        gl.endQuery((ext as TimerExt).TIME_ELAPSED_EXT)
        gl.deleteQuery(open)
        open = null
      }
      dropPending()
    },
    begin() {
      if (!enabled || !ext || open) return
      const q = gl.createQuery()
      if (!q) return
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
      open = q
    },
    end() {
      if (!ext) return
      if (open) {
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        pending.push(open)
        open = null
      }
      if (pending.length === 0) return
      // A disjoint invalidates everything in flight; the results would be lies.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT) === true) {
        dropPending()
        return
      }
      // Harvest from the oldest. Results land in order, so stop at the first
      // one that has not.
      while (pending.length > 0) {
        const q = pending[0] as WebGLQuery
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) break
        push((gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6)
        gl.deleteQuery(q)
        pending.shift()
      }
      // A driver that never answers must not grow the queue without bound.
      while (pending.length > MAX_PENDING) gl.deleteQuery(pending.shift() as WebGLQuery)
    },
    stats() {
      if (count === 0) return { frames: 0, medianMs: 0, p95Ms: 0, maxMs: 0 }
      const sorted = Array.from(ring.subarray(0, count)).sort((a, b) => a - b)
      return {
        frames: count,
        medianMs: sorted[Math.floor(count / 2)] as number,
        p95Ms: sorted[Math.min(count - 1, Math.floor(count * 0.95))] as number,
        maxMs: sorted[count - 1] as number,
      }
    },
    reset() {
      head = 0
      count = 0
    },
  }
}
