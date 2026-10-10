// src/editor/bench/policy.ts — the bench's numbers, in one place. DEV-492.
//
// Every number here is a CALL, and most of them are Matt's to move once he
// has worn it: reach, table height and scale are exactly what a flat test
// cannot judge (the row's wear-only checklist says which). Pinned by value in
// `tests/unit/editor-bench.test.ts`, so a move is on purpose.

export const BENCH_POLICY = {
  /**
   * World metres per bench metre: ~1:2000 (EDITOR.md §5.3, "a hand's
   * centimetre is tens of metres"). A FIXED scale rather than a fixed table,
   * so twenty metres feel the same over every island; Simonet's 4096 m map is
   * then a 2.05 m table.
   */
  worldPerBenchMetre: 2000,
  /**
   * Vertical exaggeration on the bench. The level select's tables use 1.35 so
   * a 0.5 m island reads as relief; the bench is where an altitude is SET, so
   * it reads true.
   */
  relief: 1,
  /** Cells across the model: ~1 cm facets on a two-metre island. */
  grid: 192,
  /**
   * The island's centre, metres out from the seated eye along the seat's own
   * resting bearing: the near shore half a metre in front of you, the far one
   * two and a half out, where the laser reaches it.
   */
  centreReach: 1.55,
  /**
   * The waterline, metres under the seated eye. Low, like a desk at lap
   * height, so Simonet's 900 m peaks (0.45 m at 1:2000) stay under the eye.
   */
  waterBelowEye: 0.95,
  /** Grip takes a handle within this of the HAND, metres (the bench's frame). */
  handReach: 0.08,
  /** Or the handle the ray passes within this of, plus `pickPerMetre` a metre out. */
  pickTolerance: 0.015,
  pickPerMetre: 0.02,
  /** How far the ray is marched onto the island, and in what steps (bench metres). */
  rayReach: 4,
  rayStep: 0.005,
  /** A handle's radius, bench metres: a fingertip. */
  handleRadius: 0.012,
  /** A drag re-evaluates the course at most this often (the warnings are not free). */
  dragEvaluateMs: 150,
  /** And re-lays the drawn line and the jets' path at most this often. */
  dragLineMs: 60,
  /** A change is saved this long after the last one (the desktop's own habit). */
  autosaveMs: 800,
  /** The plate: metres wide, and how far in front of the near shore it stands. */
  plateWidth: 0.72,
  plateNearShore: 0.12,
  /** The world ring on the bench is drawn at least this big, bench metres, so it can be seen. */
  ringMinRadius: 0.006,
} as const
