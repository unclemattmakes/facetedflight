// src/game/tv/tv-standings.ts: who passed whom. DEV-652 (and DEV-641, DEV-654).
//
// The Director cuts on an overtake; the standings board comes up on one; wave
// 2's overtake cue and the lower third ("CUTTER takes #1") read the same
// event. So the rule is one small pure function over the places TV already
// computes (the camera's `Seen.place`, the board's row order), never a second
// derivation in each place.
//
// ── Debounced ─────────────────────────────────────────────────────────────
//
// Two racers side by side swap places every frame on a one-metre difference in
// their progress along the line, which is not an overtake anybody saw. The
// tracker adopts a new order only once it has stood for `TV_ORDER_SETTLE_SECONDS`,
// and reports the racers that moved UP between the orders it adopted.
//
// Pure: no three, no DOM, no clock (time is the sum of the `dt`s it is given).

/** A new order must stand this long before it is an order (seconds). */
export const TV_ORDER_SETTLE_SECONDS = 0.5

/** One racer's gain: it was `from`th, it is `to`th (1-based places). */
export interface PlaceGain {
  readonly id: string
  readonly from: number
  readonly to: number
}

/**
 * The racers that moved up between two orders of the same racers (ids by
 * place, first leads). A racer that joined or left is not an overtake.
 */
export const placeGains = (prev: readonly string[], next: readonly string[]): PlaceGain[] => {
  // DEV-886: a racer that LEFT (it crossed the line) lifts everyone behind it a
  // place, and that is not an overtake: "CUTIE takes #4" was said of a racer who
  // passed nobody. Only the racers in both orders are compared, against each
  // other; the places reported are the real ones in `next`.
  const inNext = new Set(next)
  const inPrev = new Set(prev)
  const common = prev.filter((id) => inNext.has(id))
  const was = new Map(common.map((id, i) => [id, i] as const))
  const gains: PlaceGain[] = []
  let k = 0
  next.forEach((id, i) => {
    if (!inPrev.has(id)) return
    const rank = was.get(id) as number
    if (k < rank) gains.push({ id, from: prev.indexOf(id) + 1, to: i + 1 })
    k += 1
  })
  return gains
}

export interface TvStandingsTracker {
  /**
   * One frame: the racers' ids by place, and the seconds it took. Returns the
   * gains of the order adopted THIS frame, or an empty list.
   */
  step(order: readonly string[], dt: number): readonly PlaceGain[]
  /** The order last adopted. */
  readonly order: readonly string[]
  /** Overtakes reported since creation. */
  readonly overtakes: number
}

export const createStandingsTracker = (): TvStandingsTracker => {
  let adopted: readonly string[] = []
  let candidate: readonly string[] = []
  let candidateFor = 0
  let overtakes = 0
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((id, i) => id === b[i])
  return {
    step(order, dt) {
      if (adopted.length === 0) {
        adopted = [...order]
        return []
      }
      if (same(order, adopted)) {
        candidate = []
        candidateFor = 0
        return []
      }
      if (!same(order, candidate)) {
        candidate = [...order]
        candidateFor = 0
      }
      candidateFor += dt
      if (candidateFor < TV_ORDER_SETTLE_SECONDS) return []
      const gains = placeGains(adopted, candidate)
      adopted = candidate
      candidate = []
      candidateFor = 0
      overtakes += gains.length
      return gains
    },
    get order() {
      return adopted
    },
    get overtakes() {
      return overtakes
    },
  }
}

// ── Finish calls (DEV-871) ─────────────────────────────────────────────────
//
// Matt, 2026-10-08: *"racers that are remaining after others have finished are
// being announced as '#1' when their position is the same. we should announce
// when a racer has crossed what their position is."* The overtake tracker above
// reads only the racers still in the air, so its places count from 1 again once
// somebody is home. A racer's FINISHING place is a different fact: how many
// crossed before it, settled at the moment it crosses and never revised.

/** A racer that has crossed the line: its id and the place it crossed in (1-based). */
export interface FinishCall {
  readonly id: string
  readonly place: number
}

export interface TvFinishTracker {
  /**
   * One frame: the ids of every racer that has crossed, in the order they did
   * (earliest first; racers that crossed on the same frame in the order given).
   * Returns the racers that crossed since the last frame, each with its place.
   * The first frame is a baseline: a viewer who arrives with racers already
   * home hears nothing about them.
   */
  step(crossed: readonly string[]): readonly FinishCall[]
  /** The place a racer crossed in, or null if it has not. */
  placeOf(id: string): number | null
}

export const createFinishTracker = (): TvFinishTracker => {
  const places = new Map<string, number>()
  let primed = false
  return {
    step(crossed) {
      if (crossed.length === 0) {
        places.clear()
        primed = true
        return []
      }
      const calls: FinishCall[] = []
      for (const id of crossed) {
        if (places.has(id)) continue
        const place = places.size + 1
        places.set(id, place)
        if (primed) calls.push({ id, place })
      }
      primed = true
      return calls
    },
    placeOf: (id) => places.get(id) ?? null,
  }
}
