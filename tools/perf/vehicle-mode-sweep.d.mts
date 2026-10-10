// tools/perf/vehicle-mode-sweep.d.mts — types for DEV-230's runner, so a unit
// test can reach the parts that decide what a row MEANS without a GPU, a
// headset or a quiet hour.
//
// The bargain `floor-sweep.d.mts` and `measure-queue.d.mts` already make.
// Everything in `vehicle-mode-sweep.mjs` that is arithmetic or a data check
// rather than I/O is exported: the CSV reader, the median, the pre-flight, the
// 2x2 arithmetic and the verdict thresholds. The sweep itself is run by hand;
// the logic that turns its output into an attribution is not allowed to be.

/** The spec each arm drives — one 60 s flight through the real compositor. */
export declare const SPEC: string

/** Seconds of recorded flight per arm. */
export declare const DEFAULT_SECONDS: number

/** Boot, load, Enter VR and launch per arm — for the runtime estimate only. */
export declare const ARM_OVERHEAD_SECONDS: number

export type Vehicle = 'hoverjet' | 'jumpseat'
export type Mode = 'ringAttack' | 'targetPractice' | 'freeFlight' | 'energyRace'

/**
 * How an arm removes work, which decides what its millisecond means.
 *
 * `content` is the one this file adds over `floor-sweep.mjs`: a different level
 * or a different mode, with no runtime call signature to prove it fired. Its
 * proof is {@link preflight}, taken out of the JSON before the GPU is touched.
 */
export type ArmMechanism = 'content' | 'draws' | 'build' | 'lights' | 'pass+define' | 'none'

/** `cell` is one square of a 2x2; `suspect` is a subtractive arm on the baseline. */
export type ArmKind = 'cell' | 'suspect'

export interface Arm {
  readonly name: string
  /** The level id to fly. Defaults to the baseline mission. */
  readonly mission?: string
  /** Extra query parameters, e.g. `mode=targetPractice` (`VRTO3D_QUERY`). */
  readonly query?: string
  /** Which 2x2 this cell belongs to, or `null` for a suspect. */
  readonly block?: string | null
  /** What the arm CLAIMS it produces. {@link preflight} holds it to this. */
  readonly vehicle?: Vehicle
  readonly mode?: Mode
  readonly kind: ArmKind
  /** Stage groups to hide (`VRTO3D_HIDE`). */
  readonly hide?: readonly string[]
  /** The one group to show, everything else hidden (`VRTO3D_SOLO`). */
  readonly solo?: readonly string[]
  /** Dotted edition flags to switch off / on. */
  readonly flagsOff?: readonly string[]
  readonly flagsOn?: readonly string[]
  readonly mechanism: ArmMechanism
  readonly why: string
}

/** The bracket, which is also cell A/hoverjet/ringAttack. */
export declare const BASELINE: Arm & { readonly mission: string }

/** The sweep, in order. `main()` brackets it with a baseline at each end. */
export declare const DEFAULT_ARMS: readonly Arm[]

/** Median of a numeric array. Empty is `null`, never `0` — a zero reads as free. */
export declare const median: (xs: readonly number[]) => number | null

export interface TraceMedians {
  /** Median draw calls over the recorded frames — a `draws` arm's proof it fired. */
  readonly calls: number | null
  readonly triangles: number | null
  readonly rows: number
  /**
   * Metres flown over the ground, summed frame to frame. DEV-233.
   *
   * `null` when the trace predates `ship_x`/`ship_z`. Two arms that flew
   * different distances are not two measurements of one quantity: the camera
   * rides the ship and this renderer is priced by where the camera is.
   */
  readonly path: number | null
  /** `elapsed_s` first to last — SIM seconds actually recorded, not requested. */
  readonly span: number | null
  /** Median adaptive render scale. Two arms at 0.6 and 1.0 differ 2.78x in pixels. */
  readonly scale: number | null
  /** How far the flight ranged. A long path inside a small box is a circle. */
  readonly bbox: { readonly x: number; readonly z: number } | null
}

/**
 * Medians and the FLIGHT out of a trace CSV, by COLUMN NAME.
 *
 * The trace's column list is a wire format that is appended to
 * (`docs/testing/perf-protocol.md` §5a), so an index is right until it is not.
 */
export declare const readTrace: (csvPath: string) => TraceMedians | null

/** The per-eye viewport out of the trace header's `projection` (DEV-227). */
export declare const readRigPixels: (
  csvPath: string,
) => { readonly w: number; readonly h: number } | null

/** `?adaptive=0`, appended to every arm. See the constant's own note. */
export declare const PIN_QUERY: string

/** An arm's query with {@link PIN_QUERY} merged in, unless the arm spells it itself. */
export declare const armQuery: (arm: Arm, pin?: boolean) => string

/** Metres of path spread within one block before its main effects are refused. */
export declare const FLIGHT_PATH_TOLERANCE_M: number

/** Seconds of recorded-span spread before a block is refused. */
export declare const FLIGHT_SPAN_TOLERANCE_S: number

/** How far a row's median render scale may sit from the bracket's. */
export declare const SCALE_TOLERANCE: number

/** Wave 3 §5's cockpit A/B, and the rig it was measured on. */
export declare const WAVE3_COCKPIT_MS: number
export declare const WAVE3_RIG_PX: number

/**
 * What the calibration arm should report on THIS rig — the rig, and nothing else.
 *
 * The adaptive render scale is deliberately NOT a factor here: when the two
 * halves of the subtraction ran at different resolutions the report refuses to
 * compare rather than correcting, because a resolution change moves the whole
 * frame and no factor repairs it. The `.mjs` carries the argument.
 *
 * `null` when the rig is unknown — the report then says it could not check,
 * rather than comparing against an expectation about somebody else's hardware.
 */
export declare const expectedCockpitMs: (rigPx: number | null) => number | null

/**
 * Did these rows fly the same flight? DEV-233's refusal.
 *
 * `ok` is false only when the data EXISTS and disagrees: a trace with no ship
 * track reports `ok: true` with a reason saying it could not check, because a
 * guard that failed closed on missing data would refuse every historical run
 * rather than the arms that deserve it.
 */
export declare const flightAgreement: (
  rows: readonly (ArmRow | null)[],
  pathTolerance?: number,
  spanTolerance?: number,
) => { readonly ok: boolean; readonly reason: string; readonly note: string }

export interface ArmReading {
  readonly gpu: { readonly p50: number; readonly p95: number } | null
  readonly dt: { readonly p50: number; readonly p95: number } | null
  readonly render: { readonly p50: number; readonly p95: number } | null
  readonly frames: number | null
  readonly gpuFrames: number | null
  readonly hitches: number | null
  readonly tierFraction: number | null
  readonly trace: TraceMedians | null
  /** The rig's per-eye viewport, for {@link expectedCockpitMs}. `null` on flat. */
  readonly rig?: { readonly w: number; readonly h: number } | null
}

/** What one arm's run left on disk, or `null` if it left none. */
export declare const readArm: (
  dir: string,
  mission: string,
  edition: string,
  seconds: number,
) => ArmReading | null

/** A level out of either tree, in `loadLevel`'s own order: generated, then authored. */
export declare const readLevel: (
  repo: string,
  id: string,
) => { readonly tree: 'levels' | 'authored'; readonly level: Record<string, unknown> } | null

/**
 * `game/modes.ts`'s `runningMode`, over the raw JSON.
 *
 * Duplicated rather than imported because this is a `.mjs` tool — and the
 * duplication is the hazard trap 24 names, so the unit test asserts the two
 * AGREE over every shipped level and every mode rather than asserting either
 * one's output.
 */
export declare const runningModeOf: (
  level: Record<string, unknown>,
  requested: string | null,
) => string

/** The modes whose row teaches. Held equal to `game/modes.ts` by the unit test. DEV-377. */
export declare const TEACHING_MODES: readonly string[]

export interface PreflightResult {
  readonly ok: boolean
  readonly tree?: string
  readonly vehicle?: string
  readonly mode?: string
  readonly note: string
}

/** Does this arm produce the vehicle and mode it claims? Decided from the JSON. */
export declare const preflight: (arm: Arm, repo: string) => PreflightResult

/**
 * Every cell's pre-flight, plus the check no single arm can make: that a
 * block's four cells are four DIFFERENT (vehicle, mode) pairs. A 2x2 whose
 * cells collapse is the failure this sweep exists to avoid and it cannot be
 * seen one row at a time.
 */
export declare const preflightAll: (
  arms: readonly Arm[],
  repo: string,
) => {
  readonly rows: readonly { readonly arm: Arm; readonly check: PreflightResult }[]
  readonly problems: readonly string[]
}

/** What a completed 2x2 means. Thresholds are stated so a reader can disagree. */
export declare const verdict: (
  vehicle: number | null,
  mode: number | null,
  drift: number,
  term?: number,
) => string

export interface ArmRow {
  readonly arm: Arm
  readonly dir?: string
  readonly mission?: string
  readonly status?: number | null
  readonly read?: ArmReading | null
  readonly skipped?: boolean
}

export interface ReportOptions {
  readonly mission: string
  readonly edition: string
  readonly seconds: number
  readonly outDir?: string
  readonly dryRun?: boolean
  /** `false` is `--no-pin`: the adaptive controller is left free. DEV-233. */
  readonly pin?: boolean
}

/** The tables, as text. `echo` is injectable so a test can drive the whole report. */
export declare const report: (
  rows: readonly ArmRow[],
  opts: ReportOptions,
  echo?: (line?: string) => void,
) => string
