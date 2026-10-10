// src/boot/stats-beacon.ts: the page's half of gameplay statistics. DEV-590,
// DEV-591 and DEV-592; docs/plan/ANALYTICS.md, docs/stats.md.
//
// One module-level `stats` that the rest of the client calls with one-liners
// (`stats.stage('hangar')`, `stats.count('posts')`); it is inert until
// `startStats()` runs, and it stays inert for good when `statsAllowed` says no.
// The rows themselves are `game/stats-tally.ts`, pure and unit-tested; this
// file owns what a page has to: the listeners, the clock and the send.
//
// WHEN NOTHING IS SENT (`statsAllowed`, tested in `stats-tally.test.ts`):
//
//   - the player said no on /privacy (`STATS_OPT_OUT_KEY` in this browser's
//     storage), or the browser sends Global Privacy Control or Do Not Track;
//   - a build that is not production (`pnpm dev`), or a page served from this
//     machine or a LAN address (`vite preview`, the e2e suite, a headset on the
//     LAN): a local build is not a player;
//   - an address with any switch that is not a PLAYER's (a room, TV or lap
//     link, a mission or look link) or a referrer's tag (`utm_*` and the
//     like). `?perf=1`, `?quality=`, `?view=` and every development switch
//     turn statistics off, so a measurement session never pollutes the
//     picture of players' machines. This is the rule a player's browser
//     follows too; the suite takes no different path, it is simply never a
//     player (CLAUDE.md, "never make the test harness take a different code
//     path").
//
// WHAT IT COSTS A FRAME: nothing. Rows are built when the page is hidden. The
// one timer samples the frame recorder's existing 3 s window every 3 s while a
// mission is on screen, which is a read of numbers the recorder already keeps.

import type { WebGLRenderer } from 'three'
import { BUILD_MODE, BUILD_VERSION } from '@/boot/version'
import { BUILD_CHANNEL } from '@/content/build-channel'
import {
  type AttemptEnding,
  type AttemptReading,
  AttemptTally,
  type BugReading,
  bugRow,
  type CrashCause,
  type ErrorSource,
  ErrorTally,
  ownFrame,
  STATS_ATTEMPTS_KEY,
  STATS_OPT_OUT_KEY,
  statsAllowed,
  type VisitCount,
  type VisitInput,
  type VisitReading,
  type VisitStage,
  VisitTally,
  type XrOutcome,
} from '@/game/stats-tally'
import { readFlagKey, safeLocalStorage } from '@/game/storage'
import { STATS_BUG_ERRORS, STATS_MAX_ROWS, type StatsRow } from '@/net/stats-schema'

/** Where the rows go. Same origin, so no cookie, no CORS and no third party. */
export const STATS_ENDPOINT = '/api/stats'

/** Set by the button on /privacy, in this site's local storage. `privacy-page.ts` names it. */
export { STATS_OPT_OUT_KEY }

/** How often the frame recorder's window is read while a mission is on screen. */
const SAMPLE_MS = 3000

/** What the game lends once it exists. Plain getters; none is called per frame. */
export interface StatsDeps {
  readonly reading: () => Omit<
    VisitReading,
    'build' | 'channel' | 'device' | 'gate' | 'xrBlocker' | 'now'
  >
  /** Is a mission on screen right now (the only time a frame sample means anything)? */
  readonly inMission: () => boolean
  /** The frame recorder's window. */
  readonly frames: () => {
    readonly p50Ms: number
    readonly p95Ms: number
    readonly hitches: number
  }
  /** The run as it stands, for an attempt's row and a crash's (DEV-593). */
  readonly attempt: () => AttemptReading
  /** Where the player is, for a bug report (DEV-622). */
  readonly bug: () => BugReading
  /** Did the capability gate find `immersive-vr`? */
  readonly immersiveVr: boolean
  /** The renderer's canvas, XR manager and debug hooks. */
  readonly renderer: Pick<WebGLRenderer, 'domElement' | 'xr' | 'debug'>
}

const now = (): number => performance.now() / 1000

/** Desktop, phone, tablet or a headset's own browser, from what the browser says it is. */
const deviceClass = (): VisitReading['device'] => {
  try {
    const ua = navigator.userAgent
    if (/OculusBrowser|Quest|Pico|Wolvic|MobileVR/i.test(ua)) return 'headset'
    const touch = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches
    if (!touch) return 'desktop'
    return Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet'
  } catch {
    return 'unknown'
  }
}

/** Why `immersive-vr` is unavailable, without asking the runtime a second time. */
const xrBlockerOf = (immersiveVr: boolean | null): string => {
  if (immersiveVr === null) return 'unprobed'
  if (immersiveVr) return 'none'
  if (!isSecureContext) return 'insecure-context'
  if (!('xr' in navigator)) return 'no-webxr-api'
  return 'no-active-runtime'
}

/**
 * This device's count of goes at each course (DEV-593), so an attempt can say
 * whether it is a first go. Only its bucket is ever sent (`ATTEMPT_BUCKETS`);
 * the count stays here. `privacy-page.ts` names the key.
 */
// Not on `readJsonKey` / `writeJsonKey` on purpose (BE-2): this is the one site
// that tells an ABSENT key (start from `{}`) from a CORRUPT one (answer 1 and
// leave the key alone), and whose failed write still answers 1 rather than the
// count. Folding it in would change what a hand-edited key does.
const bumpAttemptCount = (mission: string): number => {
  try {
    const counts = JSON.parse(localStorage.getItem(STATS_ATTEMPTS_KEY) ?? '{}') as Record<
      string,
      number
    >
    const n = (typeof counts[mission] === 'number' ? counts[mission] : 0) + 1
    counts[mission] = n
    localStorage.setItem(STATS_ATTEMPTS_KEY, JSON.stringify(counts))
    return n
  } catch {
    return 1
  }
}

const readOptOut = (): boolean => readFlagKey(safeLocalStorage(), STATS_OPT_OUT_KEY)

class Stats {
  private on = false
  private readonly visit = new VisitTally()
  private readonly errors = new ErrorTally()
  private deps: StatsDeps | null = null
  private gateValue: VisitReading['gate'] = 'ok'
  private readonly device = deviceClass()
  private lastScale = 1
  private readonly attempt = new AttemptTally()
  /** Attempt and crash rows waiting for the next send (DEV-593): nothing is sent mid-play. */
  private readonly pending: StatsRow[] = []
  /** The last few errors, kept in memory whether or not this page reports, for a bug report. */
  private readonly recent: string[] = []

  /** Decide, once, whether this page reports; install the page's listeners if so. */
  start(): void {
    if (this.on) return
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
    this.on = statsAllowed({
      production: BUILD_MODE === 'production',
      hostname: location.hostname,
      search: location.search,
      gpc: nav.globalPrivacyControl === true,
      dnt: nav.doNotTrack === '1',
      optedOut: readOptOut(),
    })
    // Errors are heard on every page, so a bug report can carry the last few;
    // they become rows only where this page reports (`error`).
    addEventListener('error', (e) => {
      this.error('error', e.message || String(e.error), (e.error as Error | undefined)?.stack)
    })
    addEventListener('unhandledrejection', (e) => {
      const reason = e.reason as { message?: unknown; stack?: unknown } | undefined
      const message = typeof reason?.message === 'string' ? reason.message : String(e.reason)
      this.error('rejection', message, typeof reason?.stack === 'string' ? reason.stack : undefined)
    })
    if (!this.on) return
    this.visit.stage('booted')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.send()
    })
    addEventListener('pagehide', () => {
      this.attemptEnd('left-page', 'none')
      this.send()
    })
  }

  /** The game is up: lend the getters, and watch the renderer. */
  attach(deps: StatsDeps): void {
    if (!this.on || this.deps) return
    this.deps = deps
    this.visit.xr(deps.immersiveVr ? 'offered' : 'unsupported')
    const { renderer } = deps
    renderer.domElement.addEventListener('webglcontextlost', () => {
      this.visit.count('contextLosses')
      this.error('context-lost', 'WebGL context lost', undefined)
    })
    if (renderer.debug.onShaderError === null) {
      renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        // three logs these itself only when no hook is set, so this logs them too.
        const log = gl.getProgramInfoLog(program) ?? ''
        console.error(
          'THREE.WebGLProgram: shader error',
          log,
          gl.getShaderInfoLog(vertex) ?? '',
          gl.getShaderInfoLog(fragment) ?? '',
        )
        this.visit.count('shaderFailures')
        this.error('shader', `program failed: ${log.split('\n')[0] ?? ''}`, undefined)
      }
    }
    renderer.xr.addEventListener('sessionstart', () => {
      this.visit.xrSessionStarted(now())
      const session = renderer.xr.getSession()
      const look = (): void => {
        if (session && [...session.inputSources].some((s) => s.gamepad))
          this.visit.input('xrControllers')
      }
      look()
      session?.addEventListener('inputsourceschange', look)
    })
    renderer.xr.addEventListener('sessionend', () => this.visit.xrSessionEnded(now()))
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !deps.inMission()) return
      const f = deps.frames()
      this.visit.frameSample(f.p50Ms, f.p95Ms, f.hitches)
      const scale = deps.reading().scale
      if (scale < this.lastScale - 0.001) this.visit.count('tierDrops')
      this.lastScale = scale
    }, SAMPLE_MS)
  }

  // ── The one-liners ───────────────────────────────────────────────────────

  gate(gate: VisitReading['gate']): void {
    this.gateValue = gate
    this.send()
  }

  stage(stage: VisitStage): void {
    if (this.on) this.visit.stage(stage)
  }

  titleShown(): void {
    if (this.on) this.visit.titleShown(now())
  }

  xr(outcome: XrOutcome): void {
    if (this.on) this.visit.xr(outcome)
  }

  count(name: VisitCount): void {
    if (this.on) this.visit.count(name)
  }

  input(name: VisitInput): void {
    if (this.on) this.visit.input(name)
  }

  /** GO (DEV-593): an attempt opens, numbered by this device's count of goes at the course. */
  attemptStart(): void {
    if (!this.on || !this.deps) return
    this.attemptEnd('restarted', 'none')
    this.attempt.start(bumpAttemptCount(this.deps.attempt().mission))
  }

  /** The attempt ends, however it ends; a call with none open does nothing. */
  attemptEnd(ending: AttemptEnding, medal: string): void {
    if (!this.on || !this.deps) return
    const row = this.attempt.end(ending, medal, this.deps.attempt(), this.common())
    if (row) this.pending.push(row)
  }

  /** A crash or a reset, where it happened (DEV-593). */
  crash(
    cause: CrashCause,
    at: { readonly x: number; readonly y: number; readonly z: number },
  ): void {
    if (!this.on || !this.deps) return
    const row = this.attempt.crash(cause, at, this.deps.attempt(), this.common())
    if (row) this.pending.push(row)
  }

  /**
   * REPORT BUG's SEND (DEV-622): the player's own report, sent at once and
   * answered with a short id, or null when it could not be sent. Sent on their
   * press whatever the passive rule says, since the press IS the asking; never
   * from a development build, which has no server to take it.
   */
  async reportBug(): Promise<string | null> {
    if (BUILD_MODE !== 'production' || !this.deps) return null
    const row = bugRow(this.deps.bug(), this.reading(), this.recent)
    try {
      const answer = await fetch(STATS_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({ rows: [row] }),
      })
      if (answer.status !== 200) return null
      const { id } = (await answer.json()) as { id?: unknown }
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  private common(): Pick<VisitReading, 'build' | 'channel' | 'device'> {
    return { build: BUILD_VERSION, channel: BUILD_CHANNEL, device: this.device }
  }

  private error(source: ErrorSource, message: string, stack: string | undefined): void {
    this.recent.push(message)
    if (this.recent.length > STATS_BUG_ERRORS) this.recent.shift()
    if (!this.on) return
    this.visit.count('errors')
    this.errors.note(source, message, ownFrame(stack, location.origin), {
      build: BUILD_VERSION,
      channel: BUILD_CHANNEL,
      device: this.device,
    })
  }

  // ── The send ─────────────────────────────────────────────────────────────

  private reading(): VisitReading {
    const fallback = {
      quality: 'high',
      qualityAuto: true,
      scale: 1,
      look: 'anniversary',
      vignette: 'light',
      speedFx: 'full',
      horizon: false,
    } as const
    return {
      ...(this.deps?.reading() ?? fallback),
      build: BUILD_VERSION,
      channel: BUILD_CHANNEL,
      device: this.device,
      gate: this.gateValue,
      xrBlocker: xrBlockerOf(this.deps ? this.deps.immersiveVr : null),
      now: now(),
    }
  }

  private send(): void {
    if (!this.on) return
    const rows: StatsRow[] = []
    if (this.visit.changedSinceSent) rows.push(this.visit.row(this.reading()))
    rows.push(...this.errors.take(), ...this.pending.splice(0))
    for (let i = 0; i < rows.length; i += STATS_MAX_ROWS) {
      const body = JSON.stringify({ rows: rows.slice(i, i + STATS_MAX_ROWS) })
      try {
        const blob = new Blob([body], { type: 'text/plain' })
        if (navigator.sendBeacon?.(STATS_ENDPOINT, blob)) continue
        void fetch(STATS_ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {})
      } catch {
        // Statistics never cost the player anything, a failed send included.
      }
    }
  }
}

/** The page's statistics. Inert until `startStats()`, and for good if not allowed. */
export const stats = new Stats()

/** Decide whether this page reports, once, at the top of `main.ts`. */
export const startStats = (): void => stats.start()
