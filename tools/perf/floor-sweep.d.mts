// tools/perf/floor-sweep.d.mts — types for DEV-226's runner, so a unit test can
// reach the parts that decide what a row MEANS without a GPU in the room.
//
// The same bargain `measure-queue.d.mts` makes. Everything in `floor-sweep.mjs`
// that is arithmetic rather than I/O — the CSV reader, the median, the verdict
// thresholds — is exported so it can be tested on a machine with no SteamVR, no
// headset and no quiet hour. The sweep itself is run by hand; the logic that
// turns its output into an attribution is not allowed to be.

/** The spec each arm drives — one 60 s flight through the real compositor. */
export declare const SPEC: string

/** The mission the 3.13 ms floor is the largest share of. */
export declare const DEFAULT_MISSION: string

/** Seconds of recorded flight per arm. */
export declare const DEFAULT_SECONDS: number

/** Boot, load, Enter VR and launch per arm — for the runtime estimate only. */
export declare const ARM_OVERHEAD_SECONDS: number

/** How an arm removes work, which decides what its millisecond means. */
export type ArmMechanism = 'draws' | 'pass+define' | 'uniform-branch' | 'none'

export interface Arm {
  readonly name: string
  /** Stage groups to hide, or `['*']` for the empty-stage control. SUBTRACTIVE. */
  readonly hide?: readonly string[]
  /** The one group to show, everything else hidden. ADDITIVE. */
  readonly solo?: readonly string[]
  /** Dotted edition flags to switch off. */
  readonly flagsOff?: readonly string[]
  readonly mechanism: ArmMechanism
  readonly why: string
}

/** The sweep, in order. `main()` brackets it with a baseline at each end. */
export declare const DEFAULT_ARMS: readonly Arm[]

/** Median of a numeric array. Empty is `null`, never `0` — a zero reads as free. */
export declare const median: (xs: readonly number[]) => number | null

export interface TraceMedians {
  /** Median draw calls over the recorded frames — a `draws` arm's proof it fired. */
  readonly calls: number | null
  readonly triangles: number | null
  readonly rows: number
}

/**
 * Median `calls` and `tris` out of a trace CSV, by COLUMN NAME.
 *
 * The trace's column list is a wire format that is appended to
 * (`docs/testing/perf-protocol.md` §5a), so an index is right until it is not.
 */
export declare const readTrace: (csvPath: string) => TraceMedians | null

/** One group the arm failed to hide, as the spec's graph walk found it. */
export interface ResidueRow {
  /** `render-census.ts`'s `rowKey()`, so it reads against the census. */
  readonly group: string
  readonly objects: number
  readonly triangles: number
}

/** What the spec wrote beside the summary about the arm itself — DEV-231. */
export interface ArmResidue {
  /** Still-drawable groups. `[]` is "nothing"; `null` is "the run did not say". */
  readonly residue: readonly ResidueRow[] | null
  /** How many times the GAME tried to re-show each hidden group, by key. */
  readonly relit: Readonly<Record<string, number>>
}

/** The arm's `*.census.json`, or `null` when the run wrote none. */
export declare const readResidue: (censusPath: string) => ArmResidue | null

export interface ArmReading {
  readonly gpu: { readonly p50: number; readonly p95: number } | null
  readonly dt: { readonly p50: number; readonly p95: number } | null
  readonly render: { readonly p50: number; readonly p95: number } | null
  readonly frames: number | null
  readonly gpuFrames: number | null
  readonly hitches: number | null
  readonly tierFraction: number | null
  readonly trace: TraceMedians | null
  /** Groups still drawable after the arm. `null` from a run that did not record it. */
  readonly residue?: readonly ResidueRow[] | null
  /** Attempted re-shows per hidden group, or `null` from a run that did not record them. */
  readonly relit?: Readonly<Record<string, number>> | null
}

/** What one arm's run left on disk, or `null` if it left none. */
export declare const readArm: (
  dir: string,
  mission: string,
  edition: string,
  seconds: number,
) => ArmReading | null

export interface ArmRow {
  readonly arm: Arm
  readonly dir: string
  readonly status?: number | null
  readonly read?: ArmReading | null
}

export interface SweepOpts {
  readonly mission: string
  readonly edition: string
  readonly seconds: number
}

/**
 * The attribution table, as text.
 *
 * `echo` is injectable so a test can drive the whole report — above all the
 * BRACKET REFUSAL, which is the single rule the sweep exists to obey and the
 * one nobody would notice had broken until an hour of quiet machine was spent.
 */
export declare const report: (
  rows: readonly ArmRow[],
  opts: SweepOpts,
  echo?: (line: string) => void,
) => string

/**
 * Why the CONTROL is not a control — both lists empty when it is one (DEV-231).
 *
 * Every arm hides a SUBSET of what the empty stage hides and therefore draws a
 * SUPERSET, so `control <= arm` on calls and on triangles is an identity that
 * holds in any correct run. `report()` prints nothing below the bracket when
 * `refuse` is non-empty and `main()` exits 1: a control that drew something is
 * added to every row that is scored against it.
 *
 * It refuses on the inequality even where the control's own residue walk said
 * it drew nothing: two instruments disagreeing about one frame is not a
 * smaller problem than one of them failing, and the message says so.
 */
export declare const controlFailures: (rows: readonly ArmRow[]) => string[]

/**
 * FILL or FIXED OVERHEAD, from the empty-stage arm alone.
 *
 * The thresholds are stated in the implementation so a reader can disagree with
 * them; the number they are applied to is the only measurement. Nothing here
 * passes or fails — perf-protocol rule 1 is *print, don't gate*.
 */
export declare const verdict: (floorFloor: number | null, modelFixed?: number) => string
