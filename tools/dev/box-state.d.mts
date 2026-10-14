// Type declarations for box-state.mjs (DEV-915). Same convention as
// override-writer.d.mts: the plugin stays plain JavaScript beside the other dev
// tools and this gives the TypeScript side (vite.config.ts, the unit test) types.

import type { Plugin } from 'vite'

export declare const BOX_ROUTE: '/__ff2/box'
export declare const SAMPLE_INTERVAL_MS: number
export declare const BUSY_WINDOW_MS: number

export interface LeaseHolder {
  holder: string
  ageSeconds: number
  askedMinutes: number | null
}

export interface CpuSample {
  /** 0 to 1 across every core, or null before the sampler has two reads. */
  busy: number | null
  cores: number
  spanMs: number
}

interface CpuTimes {
  times: Record<string, number>
}

export declare function parseHolder(text: string, nowSeconds: number): LeaseHolder | null
export declare function busyBetween(
  before: readonly CpuTimes[],
  after: readonly CpuTimes[],
): number | null
export declare function createCpuSampler(opts?: {
  cpus?: () => readonly CpuTimes[]
  now?: () => number
  windowMs?: number
}): {
  sample: () => void
  read: () => CpuSample
  clear: () => void
}
export declare function leaseDirFor(root: string): string
export declare function readLease(lockDir: string, nowSeconds?: number): LeaseHolder | null
export declare function createBoxHandler(deps: {
  lockDir: string
  sampler: { read: () => CpuSample }
  now?: () => number
}): (
  req: { method?: string },
  res: {
    statusCode: number
    setHeader: (k: string, v: string) => void
    end: (body?: string) => void
  },
) => void
export declare function boxState(): Plugin
