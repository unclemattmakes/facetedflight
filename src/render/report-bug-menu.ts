// src/render/report-bug-menu.ts: REPORT BUG, a page of the pause plate's
// OPTIONS. DEV-622 (the row and the panel; the sender is the analytics
// session's).
//
// Matt, 2026-10-04: *"report bug (new option)"*. The page says, row by row,
// exactly what one press of SEND hands over (the build and its channel, where
// you are, the quality tier, the device class, the last few errors), then
// SEND and BACK. After a send the SEND row reads "Sent, thank you" with the
// short id the sender returned.
//
// NOTHING FREE-TYPED AND NOTHING PERSONAL: every value on the page is the
// game's own state, shown before it is sent. Whether flat and phone should
// get a text box is a call for Matt (QUESTIONS-FOR-MATT, Playtest 2026-10-04).
//
// The sender is a HOOK, `ReportBugHook`, passed in through `BootOptions`.
// Unset it is a no-op that returns null, and the page then says the report
// was not sent rather than thanking anyone for nothing.

import type { PauseOption } from '@/render/pause'

/** 2016's punctuation, as the other pages have it. */
export const REPORT_BUG_TITLE = '- REPORT BUG -'

/** Everything one report carries. Plain values, and all of it is on the page. */
export interface BugReport {
  /** `BUILD_VERSION`. */
  readonly version: string
  /** `BUILD_CHANNEL`: release or preview. */
  readonly channel: string
  /** The screen: mission, menu, and so on. */
  readonly screen: string
  /** The course's id. */
  readonly mission: string
  /** The run's fixed-step tick. */
  readonly tick: number
  /** The quality tier the renderer is on. */
  readonly quality: string
  /** headset, phone, or desktop. */
  readonly device: string
  /** The last few error messages this page saw, newest last. */
  readonly errors: readonly string[]
}

/**
 * The sender. Returns the report's short id, or null when nothing was sent.
 * May answer at once or later.
 */
export type ReportBugHook = (report: BugReport) => string | null | Promise<string | null>

/** The default: sends nothing. */
export const noReportBug: ReportBugHook = () => null

/** How many recent errors a report carries. */
export const REPORT_ERRORS_MAX = 5

/** Row ids, in order: the four facts, SEND, BACK. Switch on a name, never an index. */
export const REPORT_BUG_ROW_IDS = ['build', 'where', 'machine', 'errors', 'send', 'back'] as const
export type ReportBugRowId = (typeof REPORT_BUG_ROW_IDS)[number]

/** Where a send stands. */
export type SendState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'sent'; readonly id: string }
  | { readonly kind: 'failed' }

/** A message, short enough for a row's value column. */
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The page's rows for `report` and the send's state. Pure. */
export const reportBugRows = (report: BugReport, send: SendState): readonly PauseOption[] => [
  {
    id: 'build',
    label: 'Build',
    value: `${report.version} ${report.channel}`,
    note: 'the version, and release or preview',
  },
  {
    id: 'where',
    label: 'Where',
    value: report.screen === 'mission' ? `tick ${report.tick}` : report.screen,
    note: clip(report.mission, 40),
  },
  {
    id: 'machine',
    label: 'Machine',
    value: `${report.device}, ${report.quality}`,
    note: 'device class and quality tier',
  },
  {
    id: 'errors',
    label: 'Errors',
    value: String(report.errors.length),
    note:
      report.errors.length === 0 ? 'none seen on this page' : clip(report.errors.at(-1) ?? '', 40),
  },
  send.kind === 'sent'
    ? {
        id: 'send',
        label: 'Sent, thank you',
        value: send.id,
        note: 'the id, if you want to mention it',
      }
    : send.kind === 'sending'
      ? { id: 'send', label: 'Sending', note: 'one moment' }
      : send.kind === 'failed'
        ? { id: 'send', label: 'Not sent', note: 'reporting is not on in this build' }
        : { id: 'send', label: 'Send', note: 'these four lines, and nothing else' },
  { id: 'back', label: 'Back', note: 'to more' },
]

export type ReportBugAction = 'none' | 'back'

export interface ReportBugMenu {
  readonly open: boolean
  readonly title: string
  readonly rows: readonly PauseOption[]
  /** What SEND would send, or did. */
  readonly report: BugReport | null
  readonly send: SendState
  openPage(): void
  closePage(): void
  activate(index: number): ReportBugAction
}

export interface ReportBugMenuOptions {
  /** The game's state now. Read when the page opens, so the page shows what SEND sends. */
  readonly snapshot: () => BugReport
  readonly reportBug?: ReportBugHook
}

export const createReportBugMenu = (options: ReportBugMenuOptions): ReportBugMenu => {
  const hook = options.reportBug ?? noReportBug
  let open = false
  let report: BugReport | null = null
  let send: SendState = { kind: 'idle' }
  /** Bumped on every open, so a late answer for an old page is dropped. */
  let generation = 0
  const settle = (asked: number, id: string | null) => {
    if (asked !== generation) return
    send = id === null ? { kind: 'failed' } : { kind: 'sent', id }
  }
  return {
    get open() {
      return open
    },
    get title() {
      return REPORT_BUG_TITLE
    },
    get rows() {
      return reportBugRows(report ?? options.snapshot(), send)
    },
    get report() {
      return report
    },
    get send() {
      return send
    },
    openPage() {
      open = true
      generation += 1
      report = options.snapshot()
      send = { kind: 'idle' }
    },
    closePage() {
      open = false
    },
    activate(index) {
      const id = REPORT_BUG_ROW_IDS[index]
      if (id === 'back') {
        open = false
        return 'back'
      }
      if (id === 'send' && send.kind === 'idle' && report !== null) {
        const asked = generation
        send = { kind: 'sending' }
        try {
          const answer = hook(report)
          if (answer instanceof Promise) {
            answer.then(
              (id) => settle(asked, id),
              () => settle(asked, null),
            )
          } else settle(asked, answer)
        } catch {
          settle(asked, null)
        }
      }
      return 'none'
    },
  }
}

/**
 * A small ring of the page's recent error messages, for the report's ERRORS
 * line. `app.ts` feeds it from `error` and `unhandledrejection`. Separate from
 * the stats beacon's tally on purpose: that one runs only for players who
 * have not opted out, and a bug report is its own explicit press.
 */
export const createErrorRing = (max = REPORT_ERRORS_MAX) => {
  const ring: string[] = []
  return {
    push(message: string) {
      ring.push(message)
      if (ring.length > max) ring.shift()
    },
    get recent(): readonly string[] {
      return [...ring]
    },
  }
}
