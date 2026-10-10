// src/game/stats-tally.ts: the game's half of a statistics row, kept as plain
// values. DEV-590 (the visit row) and DEV-591 (the error rows);
// docs/plan/ANALYTICS.md §4.
//
// Pure: no DOM, no clock, no storage. The page (`boot/stats-beacon.ts`) owns
// the listeners, the clock and the send; this owns what the rows SAY, so the
// rules about them are unit tests rather than hopes:
//
//   - a stage or an XR outcome only ever moves forward through its list;
//   - counts go out as their increase since the last send, so a visit that is
//     hidden twice sends twice and the reader's SUM is still right; and each
//     row says where the stage and the XR outcome stood at the previous send
//     (`stageBefore`, `xrBefore`, 0 on the first), so a funnel counts a visit
//     once per stage it reached without any key between its rows;
//   - an error is sent once per distinct (cleaned) message and frame, at most
//     `STATS_ERRORS_PER_VISIT` a visit, and its words are cleaned here as well
//     as on the server, so they are clean before they leave;
//   - frame times are sampled from the recorder's window while a mission is
//     on screen and reported as the most common bucket, never as a series.
//
// Nothing in here has, or could have, a key: no id, no time of day, no order
// across visits. The `StatsRow`s it builds are checked against the schema the
// server enforces, in `stats-tally.test.ts`.

import {
  ALTITUDE_BUCKETS,
  ATTEMPT_BUCKETS,
  bucketOf,
  cleanErrorMessage,
  crashCell,
  DURATION_BUCKETS,
  FRAME_BUCKETS,
  STATS_BUG_ERRORS,
  STATS_CRASHES_PER_ATTEMPT,
  STATS_ERRORS_PER_VISIT,
  type StatsRow,
  TO_TITLE_BUCKETS,
} from '@/net/stats-schema'

export const STAGES = ['booted', 'title', 'hangar', 'mission', 'finished'] as const
export type VisitStage = (typeof STAGES)[number]

/** Ordered: `started` is further than `refused`, which is further than `pressed`. */
export const XR_OUTCOMES = ['unsupported', 'offered', 'pressed', 'refused', 'started'] as const
export type XrOutcome = (typeof XR_OUTCOMES)[number]

export const VISIT_COUNTS = [
  'attempts',
  'finishes',
  'roomsJoined',
  'tvWatched',
  'editorOpened',
  'posts',
  'ghostSaves',
  'hitches',
  'tierDrops',
  'contextLosses',
  'shaderFailures',
  'errors',
] as const
export type VisitCount = (typeof VISIT_COUNTS)[number]

export const INPUTS = ['keyboard', 'gamepad', 'touch', 'xrControllers'] as const
export type VisitInput = (typeof INPUTS)[number]

/** What the page reads off the game at the moment it sends. Plain values. */
export interface VisitReading {
  readonly build: string
  readonly channel: 'release' | 'preview'
  readonly device: 'desktop' | 'phone' | 'tablet' | 'headset' | 'unknown'
  readonly gate: 'ok' | 'no-webgl2' | 'no-asset-base' | 'failed'
  readonly xrBlocker: string
  readonly quality: 'low' | 'medium' | 'high' | 'ultra'
  readonly qualityAuto: boolean
  /** The adaptive step in force, `1` to `0.6`. */
  readonly scale: number
  readonly look: 'classic' | 'anniversary'
  readonly vignette: 'off' | 'light' | 'strong'
  readonly speedFx: 'off' | 'light' | 'full'
  readonly horizon: boolean
  /** Seconds since navigation began. */
  readonly now: number
}

/** The scale as its enum value: one of `ADAPTIVE_STEPS`, else `other`. */
export const VISIT_SCALE_LABEL = (scale: number): string => scaleLabel(scale)
const scaleLabel = (scale: number): string => {
  for (const s of ['1', '0.9', '0.8', '0.7', '0.6'])
    if (Math.abs(scale - Number(s)) < 0.005) return s
  return 'other'
}

/** The label seen most often, or `none` with no samples. Ties go to the slower label. */
const modeOf = (counts: ReadonlyMap<string, number>): string => {
  let best = 'none'
  let n = 0
  for (const label of FRAME_BUCKETS.labels) {
    const c = counts.get(label) ?? 0
    if (c > 0 && c >= n) {
      best = label
      n = c
    }
  }
  return best
}

export class VisitTally {
  private stageAt = 0
  private xrAt = 0
  private titleAt: number | null = null
  private vrSince: number | null = null
  private vrSeconds = 0
  private sentBefore = false
  /** `stageAt + 1` and `xrAt + 1` at the last send; 0 before the first. */
  private sentStage = 0
  private sentXr = 0
  private readonly counts = new Map<VisitCount, number>()
  private readonly sentCounts = new Map<VisitCount, number>()
  private readonly inputs = new Set<VisitInput>()
  private readonly p50 = new Map<string, number>()
  private readonly p95 = new Map<string, number>()
  private sentVisitSeconds = 0
  private sentVrSeconds = 0

  /** Move the furthest stage forward; a step back is ignored. */
  stage(stage: VisitStage): void {
    this.stageAt = Math.max(this.stageAt, STAGES.indexOf(stage))
  }

  /** The title's first settled frame, in seconds since navigation. The first call wins. */
  titleShown(now: number): void {
    this.stage('title')
    if (this.titleAt === null) this.titleAt = now
  }

  xr(outcome: XrOutcome): void {
    this.xrAt = Math.max(this.xrAt, XR_OUTCOMES.indexOf(outcome))
  }

  xrSessionStarted(now: number): void {
    this.xr('started')
    if (this.vrSince === null) this.vrSince = now
  }

  xrSessionEnded(now: number): void {
    if (this.vrSince === null) return
    this.vrSeconds += Math.max(0, now - this.vrSince)
    this.vrSince = null
  }

  count(name: VisitCount, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by)
  }

  input(name: VisitInput): void {
    this.inputs.add(name)
  }

  /** One sample of the frame recorder's window: its p50 and p95, ms, and its hitches. */
  frameSample(p50Ms: number, p95Ms: number, hitches: number): void {
    if (!(p50Ms > 0)) return
    const a = bucketOf(p50Ms, FRAME_BUCKETS)
    const b = bucketOf(p95Ms, FRAME_BUCKETS)
    this.p50.set(a, (this.p50.get(a) ?? 0) + 1)
    this.p95.set(b, (this.p95.get(b) ?? 0) + 1)
    if (hitches > 0) this.count('hitches', hitches)
  }

  /**
   * The row to send now. Counts and seconds are what accrued since the last
   * row; the rest is the visit's state as it stands. Durations are bucketed
   * from the increase, which is what makes two sends from one visit SUM.
   */
  row(r: VisitReading): StatsRow {
    const vrNow = this.vrSeconds + (this.vrSince === null ? 0 : Math.max(0, r.now - this.vrSince))
    const visitDelta = Math.max(0, r.now - this.sentVisitSeconds)
    const vrDelta = Math.max(0, vrNow - this.sentVrSeconds)
    const counts: Record<string, number> = {}
    for (const name of VISIT_COUNTS) {
      const total = this.counts.get(name) ?? 0
      counts[name] = total - (this.sentCounts.get(name) ?? 0)
    }
    const row: StatsRow = {
      k: 'visit',
      build: r.build,
      channel: r.channel,
      device: r.device,
      gate: r.gate,
      stage: STAGES[this.stageAt] as string,
      xr: XR_OUTCOMES[this.xrAt] as string,
      xrBlocker: r.xrBlocker,
      quality: r.quality,
      scale: scaleLabel(r.scale),
      look: r.look,
      vignette: r.vignette,
      speedFx: r.speedFx,
      toTitle:
        this.sentBefore || this.titleAt === null
          ? 'none'
          : bucketOf(this.titleAt, TO_TITLE_BUCKETS),
      visitTime: bucketOf(visitDelta, DURATION_BUCKETS),
      vrTime: bucketOf(vrDelta, DURATION_BUCKETS),
      frameP50: modeOf(this.p50),
      frameP95: modeOf(this.p95),
      stageBefore: this.sentStage,
      xrBefore: this.sentXr,
      keyboard: this.inputs.has('keyboard') ? 1 : 0,
      gamepad: this.inputs.has('gamepad') ? 1 : 0,
      touch: this.inputs.has('touch') ? 1 : 0,
      xrControllers: this.inputs.has('xrControllers') ? 1 : 0,
      horizon: r.horizon ? 1 : 0,
      qualityAuto: r.qualityAuto ? 1 : 0,
      ...counts,
    }
    // What was sent is now the baseline for the next send.
    this.sentBefore = true
    this.sentStage = this.stageAt + 1
    this.sentXr = this.xrAt + 1
    this.sentVisitSeconds = r.now
    this.sentVrSeconds = vrNow
    for (const name of VISIT_COUNTS) this.sentCounts.set(name, this.counts.get(name) ?? 0)
    this.p50.clear()
    this.p95.clear()
    return row
  }

  /** Has anything happened since the last row worth a second one? */
  get changedSinceSent(): boolean {
    if (!this.sentBefore) return true
    if (this.stageAt + 1 !== this.sentStage || this.xrAt + 1 !== this.sentXr) return true
    for (const name of VISIT_COUNTS) {
      if ((this.counts.get(name) ?? 0) !== (this.sentCounts.get(name) ?? 0)) return true
    }
    return this.p50.size > 0
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * The top stack frame inside our own bundle, as `file:line` with no host and no
 * query, or `none`. Our files are the page's own (`/assets/...` in a build,
 * `/src/...` in development); a frame in an extension or a third-party script
 * is not ours and is not reported, which is also what keeps an extension's
 * address out of a row.
 */
export const ownFrame = (stack: string | undefined, origin: string): string => {
  if (!stack) return 'none'
  for (const line of stack.split('\n')) {
    const at = line.indexOf(origin)
    if (at < 0) continue
    const m = /^\/((?:assets|src)\/[\w./-]{1,72}?)(?:\?[^:\s)]*)?:(\d{1,7})(?::\d+)?/.exec(
      line.slice(at + origin.length),
    )
    if (m) return `${m[1]}:${m[2]}`
  }
  return 'none'
}

export type ErrorSource = 'error' | 'rejection' | 'frame' | 'shader' | 'context-lost'

export class ErrorTally {
  private readonly seen = new Set<string>()
  private readonly queue: StatsRow[] = []

  /**
   * Note an error. Returns true when it becomes a row (a new message and frame,
   * under the cap); either way the caller counts it on the visit.
   */
  note(
    source: ErrorSource,
    message: string,
    frame: string,
    r: Pick<VisitReading, 'build' | 'channel' | 'device'>,
  ): boolean {
    const clean = cleanErrorMessage(message) || '(empty)'
    const key = `${source}\n${clean}\n${frame}`
    if (this.seen.has(key) || this.seen.size >= STATS_ERRORS_PER_VISIT) return false
    this.seen.add(key)
    this.queue.push({
      k: 'error',
      build: r.build,
      channel: r.channel,
      device: r.device,
      source,
      message: clean,
      frame,
    })
    return true
  }

  /** The rows not sent yet, emptied. */
  take(): StatsRow[] {
    return this.queue.splice(0)
  }
}

// ── Whether a page reports at all ─────────────────────────────────────────

/**
 * The key the /privacy page's button sets to `1` in this site's local storage
 * to stop this browser sending statistics. `privacy-page.ts` names it
 * (`PRIVACY_BROWSER_STORES.statsOff`), and `privacy-page.test.ts` holds the
 * two equal.
 */
export const STATS_OPT_OUT_KEY = 'ff2.stats.off.v1'

/**
 * DEV-593: this device's count of goes at each course, in local storage. Only
 * the count's bucket is ever sent. `privacy-page.ts` names it
 * (`PRIVACY_BROWSER_STORES.statsAttempts`).
 */
export const STATS_ATTEMPTS_KEY = 'ff2.stats.attempts.v1'

/**
 * Switches a PLAYER's address may carry and still report: the links the game
 * hands out (a room, TV, a lap to race, a mission or a look) and the tags a
 * referrer adds. Anything else is a development or measurement switch, and a
 * page under one reports nothing (ANALYTICS.md §1, "development does not
 * pollute it").
 */
export const PLAYER_SWITCHES: ReadonlySet<string> = new Set([
  'room',
  'tv',
  'follow',
  'ghost',
  'mission',
  'edition',
  'fbclid',
  'gclid',
  'ref',
])

const isPlayerSwitch = (name: string): boolean =>
  PLAYER_SWITCHES.has(name) || /^utm_[a-z]+$/.test(name)

/** A host that is this machine or a private network: a local build, never a player. */
const isLocalHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost') ||
  hostname.endsWith('.test') ||
  hostname.endsWith('.local') ||
  /^127\./.test(hostname) ||
  /^10\./.test(hostname) ||
  /^192\.168\./.test(hostname) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)

export interface StatsPermission {
  /** `BUILD_MODE === 'production'`. */
  readonly production: boolean
  readonly hostname: string
  /** `location.search`. */
  readonly search: string
  /** `navigator.globalPrivacyControl`. */
  readonly gpc: boolean
  /** `navigator.doNotTrack === '1'`. */
  readonly dnt: boolean
  /** The /privacy button's key is set. */
  readonly optedOut: boolean
}

/** Does this page send statistics? Every no is final for the page. */
export const statsAllowed = (p: StatsPermission): boolean => {
  if (!p.production || p.optedOut || p.gpc || p.dnt) return false
  if (isLocalHost(p.hostname)) return false
  for (const name of new URLSearchParams(p.search).keys()) if (!isPlayerSwitch(name)) return false
  return true
}

// ── Attempts and crashes (DEV-593) ─────────────────────────────────────────

/** What the game knows about the run at the moment an attempt starts or ends. */
export interface AttemptReading {
  /** A shipped or listed course's id, or `custom` for a player's own course. */
  readonly mission: string
  readonly mode: string
  readonly look: 'classic' | 'anniversary'
  readonly opponents: 'none' | 'ai' | 'ghosts' | 'lap' | 'room'
  readonly variant: string
  readonly ringsTaken: number
  readonly ringsTotal: number
  readonly crashes: number
  /** The mission clock, seconds. */
  readonly elapsed: number
}

export type AttemptEnding = 'finished' | 'quit' | 'restarted' | 'left-page'
export type CrashCause = 'crash' | 'out-of-bounds' | 'head-strike' | 'fuel'
type Common = Pick<VisitReading, 'build' | 'channel' | 'device'>

/**
 * One attempt at a time: opened at GO, closed however it ends. Its crash rows
 * carry the mission, the look, the cause and a 50 m cell, and nothing that
 * orders or times them (`CRASH_FIELDS`); at most `STATS_CRASHES_PER_ATTEMPT`.
 */
export class AttemptTally {
  private open: { readonly attemptNo: string; resets: number; crashRows: number } | null = null

  get isOpen(): boolean {
    return this.open !== null
  }

  /** GO. `attemptNo` is this device's count of goes at this course, this one included. */
  start(attemptNo: number): void {
    this.open = { attemptNo: bucketOf(attemptNo, ATTEMPT_BUCKETS), resets: 0, crashRows: 0 }
  }

  /** A crash or a reset. Null when no attempt is open or the cap is reached. */
  crash(
    cause: CrashCause,
    at: { readonly x: number; readonly y: number; readonly z: number },
    r: Pick<AttemptReading, 'mission' | 'look'>,
    c: Pick<VisitReading, 'build' | 'channel'>,
  ): StatsRow | null {
    if (!this.open) return null
    if (cause !== 'crash') this.open.resets++
    if (this.open.crashRows >= STATS_CRASHES_PER_ATTEMPT) return null
    this.open.crashRows++
    return {
      k: 'crash',
      build: c.build,
      channel: c.channel,
      mission: r.mission,
      look: r.look,
      cause,
      cell: crashCell(at.x, at.z),
      altitude: bucketOf(at.y, ALTITUDE_BUCKETS),
    }
  }

  /** The attempt's row, and the attempt closed. Null when none was open. */
  end(ending: AttemptEnding, medal: string, r: AttemptReading, c: Common): StatsRow | null {
    const open = this.open
    if (!open) return null
    this.open = null
    const finished = ending === 'finished'
    return {
      k: 'attempt',
      build: c.build,
      channel: c.channel,
      device: c.device,
      mission: r.mission,
      mode: r.mode,
      look: r.look,
      opponents: r.opponents,
      variant: r.variant,
      ending,
      medal: finished ? medal : 'none',
      attemptNo: open.attemptNo,
      quitTime: finished ? 'none' : bucketOf(r.elapsed, DURATION_BUCKETS),
      ringsTaken: r.ringsTaken,
      ringsTotal: r.ringsTotal,
      lastRing: r.ringsTaken,
      seconds: finished ? Math.round(r.elapsed) : 0,
      crashes: r.crashes,
      resets: open.resets,
    }
  }
}

// ── A bug report (DEV-622) ──────────────────────────────────────────────────

/** Where the player is when they press SEND. */
export interface BugReading {
  readonly screen: 'title' | 'hangar' | 'mission' | 'tv' | 'editor' | 'other'
  readonly mission: string
  readonly tick: number
}

/**
 * The player's own report: the visit's setting and where they are, and the
 * last few errors this page saw, cleaned as the error rows are. Nothing typed,
 * nothing personal. The server gives it a short id the player can quote.
 */
export const bugRow = (
  b: BugReading,
  v: Omit<
    VisitReading,
    'now' | 'gate' | 'xrBlocker' | 'qualityAuto' | 'horizon' | 'vignette' | 'speedFx'
  >,
  recentErrors: readonly string[],
): StatsRow => {
  const errors = recentErrors.slice(-STATS_BUG_ERRORS).map((m) => cleanErrorMessage(m) || '(empty)')
  while (errors.length < STATS_BUG_ERRORS) errors.push('none')
  return {
    k: 'bug',
    build: v.build,
    channel: v.channel,
    device: v.device,
    screen: b.screen,
    mission: b.mission,
    quality: v.quality,
    look: v.look,
    scale: VISIT_SCALE_LABEL(v.scale),
    error1: errors[0] as string,
    error2: errors[1] as string,
    error3: errors[2] as string,
    tick: b.tick,
  }
}
