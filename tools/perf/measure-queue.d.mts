// tools/perf/measure-queue.d.ts — types for the JS runner, so a TypeScript spec
// can import its browser counter rather than spell a second one.
//
// `perf-scale.spec.ts` samples `chromeCount()` at every reading. It could have
// re-implemented the PowerShell probe locally in four lines, and that is exactly
// the duplication trap 24 is about: two counters that can disagree about what
// "a browser" is, with the quieter one silently deciding whether a measurement
// is believed. `BUSY_BROWSERS` carries the same argument — one parent is the
// desktop's own, and a parent is a `chrome.exe` with no `--type=` in its command
// line, which is the distinction the first version of that counter got wrong.

/** Independent Chrome BROWSERS alive. `null` when it cannot be established. */
export declare const chromeCount: () => number | null

export interface MachineLoad {
  /** Independent Chrome browsers — renderer children not counted. */
  readonly chrome: number | null
  /** `node.exe` processes. A sibling's tsc/vitest/playwright shows up here. */
  readonly node: number | null
  /** Total CPU load percent, the OS's own maintained figure. */
  readonly cpu: number | null
}

/**
 * All three in ONE probe. Counting browsers alone is blind to a sibling running
 * `pnpm check` — node and tsc, zero Chrome — and a CPU-starved renderer fakes
 * the exact signature of §11.11's cliff.
 */
export declare const machineLoad: () => MachineLoad

/** How many may be alive before a GPU measurement is refused. */
export declare const BUSY_BROWSERS: number

export interface GpuState {
  readonly temp: number
  readonly clock: number
  readonly maxClock: number
  readonly util: number
  readonly fraction: number
}

/** Clock, temperature and utilisation, or `null` without `nvidia-smi`. */
export declare const gpuState: () => GpuState | null

/** Cool to this before a row, and give up waiting after this long. */
export declare const COOL_TO_C: number
export declare const COOL_MAX_SECONDS: number

/**
 * Sleep until the GPU is back down to `toC`, or `maxSeconds` have passed, and
 * return the state it ended on (`null` without `nvidia-smi`).
 *
 * Exported so a second runner does not grow its own copy — the duplication trap
 * this whole sidecar exists for. `floor-sweep.mjs` is the second runner.
 */
export declare const coolDown: (toC: number, maxSeconds: number) => GpuState | null
