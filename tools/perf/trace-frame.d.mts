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
}

export interface Stat {
  readonly n: number
  readonly p50: number | null
  readonly p95: number | null
  readonly max: number | null
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
  readonly frames: readonly FrameRow[]
}

export declare const XR_SUBMIT: readonly RegExp[]
export declare const FLAT_PRESENT: readonly string[]
export declare const stat: (xs: readonly (number | null)[]) => Stat
export declare const reduceFrameTrace: (
  input: unknown,
  opts?: { fromTs?: number; toTs?: number },
) => ReducedTrace
export declare const renderFrameTable: (r: ReducedTrace) => string
