// Types for tools/perf/trace-frame.mjs, so a TypeScript spec or test can import it.

export interface FrameRow {
  readonly index: number
  readonly rafStart: number
  readonly period: number | null
  readonly js: number
  readonly flushes: number
  readonly firstFlush: number | null
  readonly lastFlush: number | null
  readonly lastFlushAfterJs: number | null
  readonly queueMax: number | null
  readonly queueSum: number | null
  readonly gpuStart: number | null
  readonly gpuEnd: number | null
  readonly gpuTail: number | null
  readonly presentEnd: number | null
  readonly gap: number | null
  /** XR columns: null when the trace has no event for the role (DEV-993). */
  readonly xrWait: number | null
  readonly xrWaitToRaf: number | null
  readonly xrSubmitStart: number | null
  readonly xrSubmitDur: number | null
  readonly xrSubmitAfterJs: number | null
  readonly xrCopy: number | null
  /** The XR chain, relative to the callback's start (ms); null when the trace lacks the event. */
  readonly xrSubFrame: number | null
  readonly xrMojoHop: number | null
  readonly xrHandleStart: number | null
  readonly xrHandleDur: number | null
  readonly xrSetSourceDur: number | null
  readonly xrRenderStart: number | null
  readonly xrRenderDur: number | null
  readonly xrFinishDur: number | null
  readonly xrWaitForGetOffset: number | null
  readonly xrCompStart: number | null
  readonly xrCompDur: number | null
  readonly xrRenderEndToEndFrame: number | null
  readonly xrNextWaitStart: number | null
  readonly xrNextWaitDur: number | null
  /** The GPU process main thread's self time in the frame, by what it was for (ms). */
  readonly gpuMainBusy?: number
  readonly gpuMain_xrComposite?: number
  readonly gpuMain_webgl?: number
  readonly gpuMain_raster?: number
  readonly gpuMain_present?: number
  readonly gpuMain_viz?: number
  readonly gpuMain_d3d?: number
  readonly gpuMain_other?: number
}

export interface Stat {
  readonly n: number
  readonly p50: number | null
  readonly p95: number | null
  readonly max: number | null
}

export interface XrPick {
  readonly pattern: string
  readonly names: readonly string[]
}

export interface ReducedTrace {
  readonly rendererPid: number | null
  readonly gpuPid: number | null
  readonly rafKind: string
  readonly presentKind: string | null
  readonly flushesMatched: number
  readonly flushesSeen: number
  readonly summary: Record<string, Stat>
  readonly xrCensus: Record<string, number>
  readonly xrPicks: {
    readonly wait: XrPick | null
    readonly submit: XrPick | null
    readonly copy: XrPick | null
  }
  readonly xrEventCensus: readonly {
    readonly process: string
    readonly thread: string
    readonly cat: string
    readonly name: string
    readonly n: number
    readonly p50Ms: number
    readonly totalMs: number
  }[]
  readonly medianPeriod: number | null
  readonly missRate: number | null
  readonly slowCount: number
  readonly slowVsFast: readonly {
    readonly column: string
    readonly fast: number | null
    readonly slow: number | null
    readonly delta: number | null
  }[]
  readonly queueCulprits: readonly {
    readonly name: string
    readonly ms: number
    readonly share: number
  }[]
  /** The same waits grouped by what the GPU thread's time was for (xrComposite, webgl, ...). */
  readonly queueBuckets: readonly {
    readonly bucket: string
    readonly ms: number
    readonly share: number
  }[]
  readonly queueIntervals: number
  readonly frames: readonly FrameRow[]
}

export declare const XR_SUBMIT: readonly RegExp[]
export declare const XR_ROLES: Record<'wait' | 'submit' | 'copy', readonly RegExp[]>
export declare const FLAT_PRESENT: readonly string[]
export declare const stat: (xs: readonly (number | null)[]) => Stat
export declare const reduceFrameTrace: (
  input: unknown,
  opts?: { fromTs?: number; toTs?: number },
) => ReducedTrace
export declare const renderFrameTable: (r: ReducedTrace) => string
export declare const scanTraceObjects: (
  file: string,
  onObject: (text: string) => void,
  chunkBytes?: number,
) => Promise<void>
export declare const loadTraceFile: (file: string) => Promise<unknown[]>
export declare const keepEvent: (
  e: unknown,
  gpuPid: number | null,
  gpuMainTid: number | null,
) => boolean
