// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
// src/boot/perf-capture.ts — record SEVERAL runs from inside the headset, then
// hand them over in one file.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// Matt, 2026-09-17: *"add a button to the VR ui so it'll start capturing perf
// logs. once i click it, then i'll do a few runs, then i'll let you know i
// stopped."*
//
// `?trace=<s>` already records a flight frame by frame, and it is the right
// recorder — `boot/perf-trace.ts` and DEV-160. What it cannot do is the thing
// that sentence asks for. It arms ONCE (`traceArmed`), saves ONCE, and writes a
// single storage key that the next run overwrites. Three runs through it leaves
// one trace, and which one is a question about ordering rather than about the
// game.
//
// The other half is worse and is the reason this is a menu row rather than a
// console call: **a query parameter is not reachable from inside a headset.**
// `?trace=120` has to be typed before the session starts, commits to a duration
// before anybody knows what they are going to fly, and cannot be changed
// without taking the Frame off. A pilot who notices something on lap three has
// no way to say so.
//
// So: a capture is a SESSION. It spans missions, restarts and exits to the
// hangar; each flight inside it contributes one trace; and it ends when the
// player says so, from the same pause plate they reached it from.
//
// ── What this module is and is not ───────────────────────────────────────
//
// It is the STATE and the PAYLOAD, and nothing else — no DOM, no download, no
// storage, no clock. Those live in `boot/app.ts` where the browser already is,
// and keeping them out of here is what lets the accumulation be tested without
// a page: a session that records three runs and hands back three runs is a
// property, and it is the property most likely to be got wrong (the recorder it
// wraps gets this wrong today, which is why this file exists).
//
// ── One file, not one per run, and the split is deliberate ───────────────
//
// A trace is ~5,000 frames × 22 columns, so a run is around half a megabyte of
// CSV. A few of those exceed what `localStorage` will hold — and a browser that
// refuses the write does it by throwing on the last one, i.e. after the earlier
// runs looked like they worked.
//
// So the payload splits by size. **The DOWNLOAD carries everything** — one
// file, at the end, so a headset session produces one prompt rather than one
// per lap. **Storage carries the SUMMARIES only**, which are a few hundred
// bytes each and are what a reader wants first anyway. If the download is
// refused, the summaries still say which run was bad; if storage is refused,
// the file still has everything.

/** What `boot/perf-trace.ts` hands over for one flight. */
export interface CaptureRun {
  /** 1-based, in the order they were flown. */
  readonly index: number
  readonly mission: string
  readonly edition: string
  /** The trace's own summary object — percentiles, hitches, worst frames. */
  readonly summary: unknown
  /** The full per-frame CSV, header line and all. */
  readonly csv: string
}

export interface CapturePayload {
  readonly kind: 'ff2-perf-capture'
  readonly version: number
  readonly runs: readonly CaptureRun[]
}

/** The summaries alone — small enough for `localStorage` when the CSVs are not. */
export interface CaptureDigest {
  readonly kind: 'ff2-perf-capture-digest'
  readonly version: number
  readonly runs: readonly { index: number; mission: string; edition: string; summary: unknown }[]
}

export const CAPTURE_VERSION = 1

export interface PerfCapture {
  /** Is a capture running right now? */
  readonly recording: boolean
  /** How many completed runs are held. */
  readonly runs: number
  /** The mission of each held run, for the menu row and the console line. */
  readonly missions: readonly string[]
  /**
   * Begin. Clears anything held — a capture is a session, and two sessions'
   * runs in one file is a file nobody can read.
   */
  start(): void
  /** Append a finished flight. Ignored while not recording. */
  add(run: Omit<CaptureRun, 'index'>): void
  /** End, and hand back everything. The state is kept so a caller can export twice. */
  stop(): CapturePayload
  /** Everything, whether or not it is still recording. */
  payload(): CapturePayload
  /** The summaries only. */
  digest(): CaptureDigest
}

export const createPerfCapture = (): PerfCapture => {
  let recording = false
  const runs: CaptureRun[] = []
  const payload = (): CapturePayload => ({
    kind: 'ff2-perf-capture',
    version: CAPTURE_VERSION,
    runs: [...runs],
  })
  return {
    get recording() {
      return recording
    },
    get runs() {
      return runs.length
    },
    get missions() {
      return runs.map((r) => r.mission)
    },
    start() {
      recording = true
      runs.length = 0
    },
    add(run) {
      // Dropped rather than queued when not recording: a trace that finishes
      // after the player has stopped the capture belongs to neither session,
      // and silently extending one session into the next is how a file ends up
      // with a run nobody flew on purpose.
      if (!recording) return
      runs.push({ ...run, index: runs.length + 1 })
    },
    stop() {
      recording = false
      return payload()
    },
    payload,
    digest: () => ({
      kind: 'ff2-perf-capture-digest',
      version: CAPTURE_VERSION,
      runs: runs.map((r) => ({
        index: r.index,
        mission: r.mission,
        edition: r.edition,
        summary: r.summary,
      })),
    }),
  }
}

/**
 * The filename a capture downloads as.
 *
 * Stamped with the time because a session is going to produce several of these
 * over an evening and `perf-capture.json (3)` tells a reader nothing. Colons are
 * illegal in a Windows filename and this machine is the one the Frame streams
 * from, so the ISO string is flattened rather than trusted.
 */
export const captureFileName = (at: Date): string =>
  `ff2-perf-capture-${at.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}.json`

/** The pause row's right-hand value: what the player sees the button doing. */
export const captureRowValue = (capture: PerfCapture): string => {
  if (!capture.recording) return capture.runs > 0 ? `${capture.runs} SAVED` : 'OFF'
  return capture.runs === 0 ? 'ON' : `ON · ${capture.runs}`
}
