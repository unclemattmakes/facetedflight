// src/boot/load-progress.ts — how far the world is, in words.
//
// ── The lie this replaces ─────────────────────────────────────────────────
//
// Measured on a warm local server with hydrated assets — the best case the game
// ever has — the Start button went live **4.5 seconds before there was an
// island** (`docs/plan/LOADING.md` R1), because `bootApp` kicks `buildWorld()`
// off as a pending promise and returns. Throttled to 4 Mbps it lit up at 31.8 s
// and a click got a faceted sky with nothing in it, which is the same picture as
// the 2026-09-09 headset session's pink sky and indistinguishable from it.
//
// `LoadTerrainOptions.onProgress` has been called once per chunk since the
// loader was written and consumed by NOTHING. This is the consumer. It is the
// third capability this port has found already built and wired to nothing
// (DEV-069's lesson; `hoverjet.input.controlScheme` and `inChain` were the
// others), which is why the aggregation lives in a file with a test rather than
// inline in `app.ts`.
//
// ── Why it says a WORD as well as a number ───────────────────────────────
//
// Two reasons, and the second is the one that made this a module.
//
// *"Name the thing being loaded"* (L1): "Loading Simonet Islands" tells a
// visitor the wait is buying them something. A bare percentage does not.
//
// And the terrains are not the whole build. `buildWorld` loads three faceted
// terrains in parallel and then assembles rings, indicators, props, ghosts, fog
// and the ship — so a bar fed only by `onProgress` reaches 100% and then SITS
// there, which is a new lie replacing the old one. The phase changes when the
// work changes: the number runs while the islands generate, and the word
// changes to say so when they are done.

/** What the loader is doing. `ready` and `failed` are terminal. */
export type LoadPhase = 'terrain' | 'assembling' | 'ready' | 'failed'

export interface LoadState {
  readonly phase: LoadPhase
  /** 0..1 across the open terrain channels. Monotonic. Only meaningful in `terrain`. */
  readonly fraction: number
  /** The place being loaded, as the level select names it — "Simonet Islands". */
  readonly place: string
  /** Why it failed, or null. */
  readonly error: string | null
}

export interface LoadProgress {
  readonly state: LoadState
  /**
   * Open a reporter for one parallel loader, to hand to
   * `LoadTerrainOptions.onProgress`.
   *
   * Open every channel BEFORE any of them reports. The aggregate is a mean, so
   * a channel opened late would drop it — which is why `fraction` is clamped
   * monotonic rather than trusted. A bar that goes backwards reads as a bug even
   * when the underlying work is fine.
   */
  channel(): (fraction: number) => void
  /** The terrains are in and the rest of the build is running. */
  assembling(): void
  ready(): void
  failed(message: string): void
  /** Start again for a mission swap, with the place it is swapping to. */
  restart(place: string): void
  /** Called on every change, and on nothing else — this fires per chunk. */
  subscribe(listener: (state: LoadState) => void): void
}

/**
 * What the landing card is counting towards while the TITLE screen loads.
 *
 * The game's name, not a place (DEV-352). The mission builder names the place
 * you chose, because there the place is the choice; the title builder used to
 * name the alpine valley its screen happens to stand in, which is true and is
 * not what a visitor who has chosen nothing is waiting for. Matt: *"name the
 * game on the card, not the environment."* The first half of the public name
 * (CLAUDE.md), because the button it is printed on is not wide enough for the
 * edition as well — and the line under the emblem already says that.
 */
export const TITLE_CARD_NAME = 'Faceted Flight'

const pct = (fraction: number): number => Math.round(fraction * 100)

/**
 * The landing card's line. Long, because the card is a page of prose and this
 * sits on a button next to it.
 */
export const cardText = (state: LoadState): string => {
  switch (state.phase) {
    case 'terrain':
      return `Loading ${state.place}… ${pct(state.fraction)}%`
    case 'assembling':
      return 'Building the course…'
    case 'failed':
      return 'Could not load'
    default:
      return 'Start'
  }
}

/**
 * DEV-471: the landing card's line under `?edit=1` once the island is in and
 * the editor is not yet drawing over it. The card goes by itself after it
 * (`main.ts`), so this is the last thing it says.
 */
export const EDITOR_OPENING_TEXT = 'Opening the editor…'

/**
 * The hangar header's line, during a mission swap. SHORT, because it is drawn
 * as geometry across the top of a holotable and the room already says `LOADING`
 * there — this is that word with the number it was missing (L5).
 */
export const busyText = (state: LoadState): string | null => {
  switch (state.phase) {
    case 'terrain':
      return `LOADING · ${pct(state.fraction)}%`
    case 'assembling':
      return 'LOADING'
    case 'failed':
      return 'FAILED'
    default:
      return null
  }
}

/**
 * The loading scene's line (DEV-355). WORDS only: the number is the plate's
 * bar, a mesh whose scale is a write per chunk, where a percentage in the text
 * would be a canvas upload per percent — a hundred of them in two seconds,
 * inside the load it is meant to be keeping smooth.
 */
export const plateText = (state: LoadState): string => {
  switch (state.phase) {
    case 'terrain':
      return `Loading ${state.place}…`
    case 'assembling':
      return 'Building the course…'
    case 'failed':
      return 'Could not load'
    default:
      return 'Ready'
  }
}

export const createLoadProgress = (place: string): LoadProgress => {
  let state: LoadState = { phase: 'terrain', fraction: 0, place, error: null }
  const listeners: ((s: LoadState) => void)[] = []
  let channels: number[] = []

  const publish = (next: LoadState): void => {
    state = next
    for (const l of listeners) l(state)
  }

  const recompute = (): void => {
    if (state.phase !== 'terrain') return
    const total = channels.reduce((a, b) => a + b, 0)
    const mean = channels.length === 0 ? 0 : total / channels.length
    // Monotonic, deliberately. See `channel()`.
    const fraction = mean > state.fraction ? (mean > 1 ? 1 : mean) : state.fraction
    if (fraction !== state.fraction) publish({ ...state, fraction })
  }

  return {
    get state() {
      return state
    },
    channel() {
      const index = channels.length
      channels.push(0)
      return (fraction: number) => {
        const v = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
        // Per CHUNK, so this runs a few hundred times a load and must not
        // allocate or notify unless something moved.
        if (channels[index] === v) return
        channels[index] = v
        recompute()
      }
    },
    assembling() {
      if (state.phase !== 'terrain') return
      publish({ ...state, phase: 'assembling', fraction: 1 })
    },
    ready() {
      if (state.phase === 'failed') return
      publish({ ...state, phase: 'ready', fraction: 1 })
    },
    failed(message) {
      publish({ ...state, phase: 'failed', error: message })
    },
    restart(next) {
      channels = []
      publish({ phase: 'terrain', fraction: 0, place: next, error: null })
    },
    subscribe(listener) {
      listeners.push(listener)
      listener(state)
    },
  }
}
