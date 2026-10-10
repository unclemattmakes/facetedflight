// tests/unit/helpers/arrival-track.ts — king-tide's remote interpolator, as the RED. DEV-387.
//
// A faithful port of king-tide `src/game/systems/remote-interp.ts` (read at
// `1758387`), minus Rapier: two samples keyed by when they ARRIVED, drawn a
// fixed 100 ms behind the local clock, lerped, extrapolation clamped at t =
// 1.5. The sender's tick is on its wire and unused, which is the design choice
// plan/MULTIPLAYER.md §4.3 refuses: a retransmit stall freezes the ship, the
// burst arrives microseconds apart, `span` collapses and it snaps. The harness
// race runs this beside `RemoteTrack` on the same stream to show it is worse.
// Test-only: nothing ships it.

export const KING_TIDE_DELAY_MS = 100
export const KING_TIDE_MAX_T = 1.5

interface Sample {
  x: number
  y: number
  z: number
  receivedAt: number
}

export class ArrivalTrack {
  #prev: Sample | null = null
  #next: Sample | null = null

  push(x: number, y: number, z: number, receivedAt: number): void {
    const s = { x, y, z, receivedAt }
    if (!this.#next) {
      this.#prev = s
      this.#next = s
      return
    }
    this.#prev = this.#next
    this.#next = s
  }

  /** The drawn position at local time `now`, or null before the first sample. */
  sample(now: number): { x: number; y: number; z: number } | null {
    const p = this.#prev
    const n = this.#next
    if (!p || !n) return null
    const renderTime = now - KING_TIDE_DELAY_MS
    const span = n.receivedAt - p.receivedAt
    let t: number
    if (span <= 0) t = 1
    else {
      t = (renderTime - p.receivedAt) / span
      if (t < 0) t = 0
      else if (t > KING_TIDE_MAX_T) t = KING_TIDE_MAX_T
    }
    return { x: p.x + (n.x - p.x) * t, y: p.y + (n.y - p.y) * t, z: p.z + (n.z - p.z) * t }
  }
}
