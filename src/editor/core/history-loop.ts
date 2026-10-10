// src/editor/core/history-loop.ts: "the loop of an edit", once.
//
// The desk, the shipped desk and the bench each hand-rolled the same five
// lines (`before = history; history = f(history); if (history !== before)
// changed()`) around `record`, and each wrapped them in its own guard: the desks
// refuse while `busy` (and a step also while a gizmo is `dragging`), the bench
// has no such state but its history is null until the level loads, and the main
// desk also clears its pad-turn note on every real change. Code-reuse BE-14.
//
// What is the same lives here; what differs is passed in, so each host's guard
// and side effect stay exactly where its author put them. A result that is the
// SAME history object records nothing and fires nothing: that is how `record`
// reports a no-op, and `undo`/`redo` at the end of a stack.

import { type History, record } from './history'

export interface HistoryLoopOptions<D> {
  /** The host's current history; null (the bench, before the level loads) makes every call a no-op. */
  readonly get: () => History<D> | null
  readonly set: (h: History<D>) => void
  /** The host's redraw/autosave, run after a change that moved the history. */
  readonly changed: () => void
  /** Run first on a change that moved the history, before `changed` (the desk's pad-turn note). */
  readonly onMoved?: () => void
  /** May a draft be recorded now? (the desks: not while busy). Default: always. */
  readonly canEdit?: () => boolean
  /** May the history be stepped now? (the desks: not while busy or dragging). Default: `canEdit`. */
  readonly canStep?: () => boolean
}

export interface HistoryLoop<D> {
  /** Record a command's result, coalescing under `coalesce` when given. */
  edit(next: D, coalesce?: string): void
  /** Replace the history by `f` of it (undo, redo, seal, or a record built by the caller). */
  step(f: (h: History<D>) => History<D>): void
}

export const createHistoryLoop = <D>(opts: HistoryLoopOptions<D>): HistoryLoop<D> => {
  const canEdit = opts.canEdit ?? ((): boolean => true)
  const canStep = opts.canStep ?? canEdit
  const run = (f: (h: History<D>) => History<D>): void => {
    const before = opts.get()
    if (!before) return
    const after = f(before)
    opts.set(after)
    if (after !== before) {
      opts.onMoved?.()
      opts.changed()
    }
  }
  return {
    edit: (next, coalesce) => {
      if (!canEdit()) return
      run((h) => record(h, next, coalesce ? { coalesce } : {}))
    },
    step: (f) => {
      if (!canStep()) return
      run(f)
    },
  }
}
