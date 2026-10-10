// src/audio/music-filter.ts: music that listens. PURE. DEV-645.
//
// CONSULTANT-REVIEW-2026-10-05 item I: "Today it reacts to launch and GO only."
// One filter pair on the music bus, no volume touched: a low-pass that closes on
// a pause and through a crash's black, a gentle high-shelf lift while boosting,
// and the low-pass opening over the last three gates. This file is the CURVE:
// what the game is doing in, what the filter should be out. The nodes are
// `webaudio.ts`'s and the smoothing is the backend's (`setTargetAtTime`), so a
// target that jumps (a pause) is heard as a close, not a step.
//
// 2016's mix has no ducking and no filtering (`mix.ts`); this is FF2's, and the
// SOUNDTRACK is untouched while the player is in a menu, on the pad or on the
// title: only a race has a floor to open from.
//
// ── Why the race has a floor at all ───────────────────────────────────────
//
// "The filter opening over the last three gates" needs somewhere to open FROM.
// While racing the music sits a little under full brightness (`raceHz`), and the
// last three gates take it to open: the run ends bright, which is the swell. The
// floor is high enough that it is felt as air rather than heard as muffling.
//
// PURE: no Web Audio, no clock. Every number is FF2's own.

/** What the music bus's filter pair should be. */
export interface MusicFilter {
  /** Low-pass cutoff, Hz. `openHz` is "no filter". */
  readonly lowpassHz: number
  /** High-shelf gain at `shelfHz`, dB. 0 is flat. */
  readonly highShelfDb: number
}

/** What the game is doing, as far as the music is concerned. */
export interface MusicListening {
  /** The pause menu (or any menu over a live run) is up. */
  readonly paused: boolean
  /** A crash holds the ship: the curtain, the hold, the black. */
  readonly crashBlack: boolean
  /** Boost is burning. */
  readonly boosting: boolean
  /** A race is on: the ship is released and the run has not ended. */
  readonly racing: boolean
  /** Gates still to take, or null where the mission has no count. */
  readonly gatesLeft: number | null
}

/** The curve's numbers, in one place a playtest changes. FF2's own. */
export const MUSIC_FILTER = {
  /** No filtering: above the audible band's useful top. */
  openHz: 20000,
  /** The race's floor, a little under full brightness. */
  raceHz: 8000,
  /** Paused or in a crash's black: a closed door, still audible. */
  duckedHz: 650,
  /** The shelf's corner, and its lift while boosting. */
  shelfHz: 3200,
  boostShelfDb: 3.5,
  /** The filter opens over this many gates, ending open on the last. */
  openingGates: 3,
} as const

/** The backend's smoothing time constant toward a new target, seconds (the door's sound). */
export const MUSIC_FILTER_SMOOTH = 0.22

/** The bus with nothing on it. */
export const MUSIC_FILTER_OPEN: MusicFilter = { lowpassHz: MUSIC_FILTER.openHz, highShelfDb: 0 }

const clamp01 = (x: number): number => (x > 0 ? (x > 1 ? 1 : x) : 0)

/**
 * How far the last-gates opening has got, 0..1: 0 with `openingGates` or more to
 * take, 1 with none. A null count (no objective) is 0: nothing to open toward.
 */
export const openingProgress = (gatesLeft: number | null): number => {
  if (gatesLeft === null || !Number.isFinite(gatesLeft)) return 0
  return clamp01((MUSIC_FILTER.openingGates - gatesLeft) / MUSIC_FILTER.openingGates)
}

/**
 * The filter for a state. Priority: a closed door beats everything (a pause or a
 * crash's black, boost lift off); then a race's floor, opened by the last gates,
 * with the boost lift on top; and anywhere that is not a race, open and flat.
 */
export const musicFilterFor = (s: MusicListening): MusicFilter => {
  if (s.paused || s.crashBlack) return { lowpassHz: MUSIC_FILTER.duckedHz, highShelfDb: 0 }
  if (!s.racing) return MUSIC_FILTER_OPEN
  const shelf = s.boosting ? MUSIC_FILTER.boostShelfDb : 0
  // Log interpolation: a cutoff is heard in octaves, so the opening is even.
  const u = openingProgress(s.gatesLeft)
  const hz = MUSIC_FILTER.raceHz * (MUSIC_FILTER.openHz / MUSIC_FILTER.raceHz) ** u
  return { lowpassHz: hz, highShelfDb: shelf }
}

/** Do two filters differ enough to be worth telling the backend? */
export const musicFilterChanged = (a: MusicFilter, b: MusicFilter): boolean =>
  Math.abs(a.lowpassHz - b.lowpassHz) > 1 || Math.abs(a.highShelfDb - b.highShelfDb) > 0.01
