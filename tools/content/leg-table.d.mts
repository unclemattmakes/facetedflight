// tools/content/leg-table.d.mts — types for DEV-378's leg table, so a unit test
// can hold its arithmetic to the numbers FLIGHT-INSTRUCTOR §2.1 and §2.6
// measured, with no vite server. The bargain `vehicle-mode-sweep.d.mts` makes:
// the arithmetic is exported and tested; the CLI is run by hand.

/** §2.6's reach, metres: ground within this either side of the line is a wall. */
export declare const WALL_METRES: number
/** Across-the-line sample spacing, metres. */
export declare const WALL_STEP: number

/** What {@link legTable} needs from the sim, injected so the tool needs no bundler to test. */
export interface LegTableDeps {
  readonly createRoute: (points: readonly (readonly number[])[]) => {
    readonly points: Float32Array
    readonly count: number
    readonly cumulative: Float32Array
    readonly length: number
  }
  readonly gateArcLengths: (
    route: never,
    gates: readonly { centre: { x: number; y: number; z: number }; radius: number }[],
  ) => number[]
  readonly routeRightAt: (
    route: never,
    s: number,
    out: { x: number; y: number; z: number },
  ) => unknown
  readonly terrainHeightAt: (field: never, x: number, z: number) => number
  readonly outsideField: (field: never, x: number, z: number) => boolean
}

export interface LegRow {
  readonly ring: number
  readonly name: string
  /** The ring's trigger centre height, metres. */
  readonly y: number
  /** Straight-line metres from the previous point (ring, or the start for ring 0). */
  readonly leg: number
  readonly climb: number
  /** Horizontal heading change at this ring, degrees; NaN for a last ring with no finish. */
  readonly turn: number
  /** Arc length on the racing line, metres. */
  readonly arc: number
  /** Line vertices on this leg that were measured against a field. */
  readonly points: number
  /** Fractions 0..1 of those with walls on both sides / exactly one; NaN with no field. */
  readonly both: number
  readonly one: number
  /** The lowest the line runs over the field on this leg, metres; NaN with no field. */
  readonly agl: number
}

export interface LegTable {
  readonly id: string
  /** What ring 0's leg is measured from. */
  readonly start: 'lift top' | 'spawn'
  readonly rings: readonly LegRow[]
  readonly lineMetres: number
  readonly lineVertices: number
  readonly finishRadius: number
  readonly ringRadius: number
  readonly measuredVertices: number
  readonly bothSides: number
  readonly oneSide: number
  readonly agl: { readonly p10: number; readonly p50: number; readonly p90: number }
  readonly turnsOver60: number
}

export declare const legTable: (level: unknown, deps: LegTableDeps, field?: unknown) => LegTable
export declare const formatLegTable: (table: LegTable, from?: number) => string
