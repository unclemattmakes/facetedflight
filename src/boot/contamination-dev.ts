// src/boot/contamination-dev.ts: the `pnpm dev` signals of a contaminated frame.
// DEV-915, docs/plan/perf-wave/perf-contamination.md.
//
// **THIS FILE MUST NOT REACH A PRODUCTION BUNDLE.** It reads the dev server's
// view of the box (`tools/dev/box-state.mjs`): who holds the GPU lease and how
// busy the host is. A deployed visitor has neither, and a build that polled an
// endpoint it cannot have would be a request per half second to a 404.
// `app.ts` imports it dynamically, inside `if (import.meta.env.DEV)`, which a
// build folds to false; `tests/unit/contamination-reach.test.ts` holds the
// import shape, and the built `dist/` is grepped for this file's marker
// strings by the same test's instructions (docs/plan/perf-wave/).
//
// Three signals, each a level the gate holds for a moment past the last sight
// of it (`render/contamination.ts`):
//
//  HMR   Vite is about to push an update (`vite:beforeUpdate`), reload the page
//        (`vite:beforeFullReload`), or has lost the page (`vite:ws:disconnect`,
//        a server restart). And the page that a full reload produced: it is
//        remembered across the reload in `sessionStorage`, and the new page is
//        flagged for its first seconds, while the dev server is still
//        re-transforming the modules it asks for.
//  LEASE The GPU lease is held by somebody who is not the wearer, while an XR
//        session is presenting. See `leaseContaminates` for why presenting.
//  CPU   The host's busy fraction over the last second is at or above
//        `HOST_CPU_BUSY`. See its note.

import { CONTAMINATION } from '@/render/contamination'

/**
 * The lease names that are a PERSON wearing the headset, not an agent working
 * (CLAUDE.md hard rule 13: a lease named like `matt-testing`). A lease held by
 * the wearer is the wearer's own session, and flagging the session as
 * contaminated by itself would be the signal eating its own tail.
 */
export const WEARER_LEASE = /^matt/i

/**
 * Host busy fraction at or above which a frame is flagged.
 *
 * 0.85, from the evidence rather than a round number: the starvation that cost
 * a flight was three full vitest suites and a smoke tier, which pin every core;
 * the game alone on this class of machine sits far under half. The cost of
 * being wrong runs both ways and is NOT symmetric. Too low and an ordinary busy
 * box blinds the controller (it holds the resolution instead of reducing it,
 * and the plate says why); too high and the flight is voided again. 0.85 across
 * every core leaves no core to spare for the frame, which is the claim.
 */
export const HOST_CPU_BUSY = 0.85

/** How often the page asks the server, ms. Under the 1.5 s a step down needs. */
export const POLL_MS = 500

/** Consecutive failed polls before the page stops asking (no such endpoint here). */
export const POLL_GIVE_UP = 3

/** A page reloaded by HMR is flagged until it has been alive this long, ms. */
export const RELOAD_SETTLE_MS = 5000

/** A reload marker older than this was a different occasion, ms. */
export const RELOAD_MARKER_MAX_AGE_MS = 20000

/** `sessionStorage`'s key for the marker. */
export const RELOAD_MARKER_KEY = 'ff2.hmr.reloadedAt'

/** The payload of `GET /__ff2/box`, as far as the page reads it. */
export interface BoxState {
  readonly lease: { readonly holder: string; readonly ageSeconds: number } | null
  readonly cpu: { readonly busy: number | null } | null
}

/**
 * Is the lease contaminating THIS page?
 *
 * Only while an XR session is presenting. The lease is held by whoever is
 * running a measurement, and a flat page under Playwright, or a developer's
 * tab, is almost always that very holder's own test: flagging it would flag
 * every spec. A presenting session is a headset (or the VRto3D rig) and the
 * question there is the one hard rule 13 asks: is somebody who is not the
 * wearer running things? The wearer's own lease (`WEARER_LEASE`) is clean, and
 * so is a lease the page was told is its own (`?lease=<name>`, for an agent
 * measuring on the rig under its own booking).
 */
export const leaseContaminates = (
  lease: BoxState['lease'],
  presenting: boolean,
  self: string | null,
): boolean => {
  if (!lease || !presenting) return false
  if (WEARER_LEASE.test(lease.holder)) return false
  if (self !== null && lease.holder === self) return false
  return true
}

/** Is the host too busy to trust a frame? A null reading is no evidence. */
export const cpuContaminates = (cpu: BoxState['cpu']): boolean =>
  cpu !== null && cpu.busy !== null && cpu.busy >= HOST_CPU_BUSY

/** The reasons a `BoxState` explains. Pure. */
export const boxMask = (box: BoxState, presenting: boolean, self: string | null): number =>
  (leaseContaminates(box.lease, presenting, self) ? CONTAMINATION.LEASE : 0) |
  (cpuContaminates(box.cpu) ? CONTAMINATION.HOST_CPU : 0)

/** The pieces of Vite's HMR client the page half uses. Structural, so a test fakes it. */
export interface HotLike {
  on(event: string, cb: () => void): void
}

export interface DevSignalsOptions {
  /** Where the reasons go: `ContaminationGate.observe`. */
  readonly observe: (mask: number) => void
  /** `renderer.xr.isPresenting`, read at each poll. */
  readonly presenting: () => boolean
  readonly hot: HotLike | undefined
  /** `performance.now`, injectable. */
  readonly now?: () => number
  readonly fetchBox?: () => Promise<BoxState>
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  readonly wallClock?: () => number
  readonly self?: string | null
  readonly setInterval?: (fn: () => void, ms: number) => unknown
  readonly clearInterval?: (id: unknown) => void
}

const defaultFetch = async (): Promise<BoxState> => {
  const response = await fetch('/__ff2/box', { cache: 'no-store' })
  if (!response.ok) throw new Error(`box ${response.status}`)
  return (await response.json()) as BoxState
}

/** `?lease=<name>`: the booking this page's operator holds, or null. */
export const selfLeaseFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get('lease')
  return value && value.length > 0 ? value : null
}

/**
 * Start the dev signals. Returns a stop function. Safe where there is no
 * `import.meta.hot`, no storage and no endpoint: each source just stays quiet.
 */
export const startDevSignals = (options: DevSignalsOptions): (() => void) => {
  const now = options.now ?? (() => performance.now())
  const fetchBox = options.fetchBox ?? defaultFetch
  const wall = options.wallClock ?? (() => Date.now())
  const self = options.self ?? null
  const every = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const stopEvery = options.clearInterval ?? ((id) => clearInterval(id as number))
  const storage =
    options.storage === undefined
      ? (() => {
          try {
            return globalThis.sessionStorage
          } catch {
            return null
          }
        })()
      : options.storage

  // ── HMR ────────────────────────────────────────────────────────────────
  //
  // `lostSocket` is a LEVEL: while the socket to the dev server is down the
  // server is restarting or gone, and the reload is coming. The two events are
  // edges, observed once; the gate holds them.
  let lostSocket = false
  options.hot?.on('vite:beforeUpdate', () => options.observe(CONTAMINATION.HMR))
  options.hot?.on('vite:beforeFullReload', () => {
    options.observe(CONTAMINATION.HMR)
    try {
      storage?.setItem(RELOAD_MARKER_KEY, String(wall()))
    } catch {
      // Storage refused (private window): the flag on THIS page still stands.
    }
  })
  options.hot?.on('vite:ws:disconnect', () => {
    lostSocket = true
    options.observe(CONTAMINATION.HMR)
  })
  options.hot?.on('vite:ws:connect', () => {
    lostSocket = false
  })

  // The page a reload produced. Read once at start: a marker is a fact about
  // how THIS page came to exist.
  let reloaded = false
  try {
    const at = Number(storage?.getItem(RELOAD_MARKER_KEY))
    reloaded = Number.isFinite(at) && at > 0 && wall() - at <= RELOAD_MARKER_MAX_AGE_MS
  } catch {
    reloaded = false
  }
  const startedAt = now()

  // ── the box ────────────────────────────────────────────────────────────
  let failures = 0
  let inFlight = false
  let stopped = false
  let timer: unknown = null
  const poll = (): void => {
    if (reloaded && now() - startedAt < RELOAD_SETTLE_MS) options.observe(CONTAMINATION.HMR)
    if (lostSocket) options.observe(CONTAMINATION.HMR)
    if (inFlight || stopped) return
    inFlight = true
    fetchBox()
      .then((box) => {
        failures = 0
        options.observe(boxMask(box, options.presenting(), self))
      })
      .catch(() => {
        failures += 1
        if (failures >= POLL_GIVE_UP) stop()
      })
      .finally(() => {
        inFlight = false
      })
  }
  const stop = (): void => {
    stopped = true
    if (timer !== null) stopEvery(timer)
    timer = null
  }
  poll()
  timer = every(poll, POLL_MS)
  return stop
}
