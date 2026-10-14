// src/boot/quiet-console.ts: silence the chatty console methods while a worn
// `?perf=1` session is measuring itself.
//
// Matt, 2026-10-13: "console messages slow perf in VR". A capture with the
// console open pays for every line it prints (formatting, retaining the
// arguments, Vite forwarding them to the dev server in dev), inside the frame
// it is measuring.
//
// Scoped to an XR session, not to `?perf=1` alone: flat `?perf=1` is the
// harness's mode, and specs read console lines there (`mission-switch-leak`
// waits on "level select: now flying"; perf run.logs are triaged from the
// forwarded console). `console.error` is never silenced: a thrown frame is
// logged once per message (`boot/app/perf.ts`, `guardedFrame`) and is the
// line a worn session most needs to keep.
//
// The methods are SWAPPED, not wrapped: a wrapper would make every log in a
// flat session point at this file instead of its own call site.

export const QUIETED = ['log', 'info', 'debug', 'warn'] as const
type Quieted = (typeof QUIETED)[number]

const silent = (): void => {}

export function createQuietConsole(target: Pick<Console, Quieted>) {
  let saved: Pick<Console, Quieted> | null = null
  return {
    get quiet(): boolean {
      return saved !== null
    },
    set(quiet: boolean): void {
      if (quiet && saved === null) {
        saved = { log: target.log, info: target.info, debug: target.debug, warn: target.warn }
        for (const k of QUIETED) target[k] = silent
      } else if (!quiet && saved !== null) {
        for (const k of QUIETED) target[k] = saved[k]
        saved = null
      }
    },
  }
}
