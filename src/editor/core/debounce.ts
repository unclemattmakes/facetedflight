// src/editor/core/debounce.ts: "do this once the edits go quiet".
//
// The desk, the shipped desk and the bench each hand-rolled the same pair for
// their autosave (`if (t) clearTimeout(t); t = setTimeout(saveNow, ms)`, and a
// `saveNow` that clears it first), and the two desks did it again for the ring
// rebuild (code-reuse BE-14). `setTimeout` is fine here: it is not a DOM API,
// and the core stays DOM-free.

export interface Debounce<R> {
  /** Run the action `ms` after the LAST call to this; a call inside the window restarts it. */
  schedule(): void
  /** Run the action now, drop any scheduled run, and return what it returned (the desk's "kept?"). */
  flush(): R
  /** Drop a scheduled run without running it. */
  cancel(): void
  /** Is a run scheduled? */
  pending(): boolean
}

export const createDebounce = <R>(action: () => R, ms: number): Debounce<R> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    schedule: () => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        action()
      }, ms)
    },
    flush: () => {
      cancel()
      return action()
    },
    cancel,
    pending: () => timer !== null,
  }
}
