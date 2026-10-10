// src/editor/core/history.ts — undo AND redo over the draft. DEV-468, E2.
//
// ── Provenance ────────────────────────────────────────────────────────────
//
// Lifted from king-tide, `src/engine/editor/undo-redo.ts` (read-only,
// `$FF2_REF/king-tide`). Kept: its logic — a bounded stack of snapshots
// (`UNDO_LIMIT` 50, the oldest dropped past it), a snapshot taken per
// "commit-worthy" mutation, and the dirty check against the depth at the last
// save. Changed:
//
//  · SNAPSHOTS ARE THE DRAFTS THEMSELVES, not `JSON.stringify` of a mutable
//    one. Every command here is a pure `(draft) → draft` that shares what it
//    did not change, so the previous draft IS the snapshot, and restoring is
//    handing it back. king-tide restored in place because its helpers held
//    references into the draft; nothing holds one here.
//  · REDO, which king-tide does not have: an undo moves the present onto a
//    `future` stack, a redo moves it back, and any new edit clears it.
//  · COALESCING, for a drag: `record(h, next, { coalesce: key })` with the key
//    of the entry on top REPLACES the present rather than pushing, so a drag of
//    three hundred mouse moves is one undo. `seal(h)` ends a drag; the next
//    drag of the same point is a new entry.
//  · The dirty check compares the COURSE with the one saved, by identity, not
//    the depth: with redo, the depth alone can return to the saved number on a
//    different branch. Selection changes are not edits and never dirty.
//  · Pure functions over an immutable value rather than a closure, so a test
//    can hold any two histories and compare them.
//
// ── DEV-540: two kinds of draft, one history ─────────────────────────────
//
// The shipped-mission door (`shipped.ts`, plan/SHIPPED-COURSE-EDITS.md §4.2)
// edits an OVERRIDE, not a player course, and records it here too, so undo
// and redo are the same code. A history now carries its draft's KIND: which
// fields an undo restores (a change to none of them is only a selection) and
// which one a save writes (the dirty check). `createHistory(draft)` with no
// kind is the player course's, exactly as before.

import type { EditorDraft } from './draft'
import { EDITOR_POLICY } from './policy'

/** What a history needs to know about its draft. Every comparison is by identity. */
export interface DraftKind<D> {
  /** The parts an undo restores. A change to none of them is a selection, and pushes no entry. */
  readonly edits: (d: D) => readonly unknown[]
  /** The part a save writes: the draft is dirty while this is not the one last saved. */
  readonly saved: (d: D) => unknown
}

/** The player course's kind (DEV-468): the course, the author lap and the credit; saved is the course. */
export const EDITOR_DRAFT_KIND: DraftKind<EditorDraft> = {
  edits: (d) => [d.course, d.authorLap, d.remixedFrom],
  saved: (d) => d.course,
}

export interface History<D = EditorDraft> {
  /** Older drafts, oldest first. */
  readonly past: readonly D[]
  readonly present: D
  /** Undone drafts, NEXT first (the one a redo returns is `future[0]`). */
  readonly future: readonly D[]
  /** The coalesce key of the entry on top, or null once sealed. */
  readonly openKey: string | null
  /** The saved part (`kind.saved`) as last saved, compared by identity. */
  readonly saved: unknown
  readonly kind: DraftKind<D>
}

export function createHistory(initial: EditorDraft): History<EditorDraft>
export function createHistory<D>(initial: D, kind: DraftKind<D>): History<D>
export function createHistory<D>(initial: D, kind?: DraftKind<D>): History<D> {
  const k = kind ?? (EDITOR_DRAFT_KIND as unknown as DraftKind<D>)
  return { past: [], present: initial, future: [], openKey: null, saved: k.saved(initial), kind: k }
}

export interface RecordOptions {
  /**
   * A drag's key, e.g. `move:3`. Successive records with the same key, and no
   * `seal` between, collapse into one undo entry.
   */
  readonly coalesce?: string
}

const sameEdits = <D>(kind: DraftKind<D>, a: D, b: D): boolean => {
  const x = kind.edits(a)
  const y = kind.edits(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * Make `next` the present.
 *
 * - `next === present` (a command that changed nothing): no entry.
 * - Only the selection changed: the present is replaced, no entry — selecting
 *   is not something to undo — and the redo stack survives it.
 * - Otherwise a new entry, or, inside an open drag with the same key, a
 *   replacement of the top one. Any new entry clears the redo stack.
 */
export const record = <D>(h: History<D>, next: D, options: RecordOptions = {}): History<D> => {
  if (next === h.present) return h
  if (sameEdits(h.kind, next, h.present)) return { ...h, present: next }
  const key = options.coalesce ?? null
  if (key !== null && key === h.openKey) {
    return { ...h, present: next, future: [] }
  }
  const past = [...h.past, h.present]
  if (past.length > EDITOR_POLICY.undoDepth) past.shift()
  return { ...h, past, present: next, future: [], openKey: key }
}

/** Close the open drag, so the next record of the same key is a new entry. */
export const seal = <D>(h: History<D>): History<D> =>
  h.openKey === null ? h : { ...h, openKey: null }

export const canUndo = <D>(h: History<D>): boolean => h.past.length > 0
export const canRedo = <D>(h: History<D>): boolean => h.future.length > 0

/** Step back one entry. A no-op (the same history) with nothing to undo. */
export const undo = <D>(h: History<D>): History<D> => {
  if (h.past.length === 0) return h
  const prev = h.past[h.past.length - 1] as D
  return {
    ...h,
    past: h.past.slice(0, -1),
    present: prev,
    future: [h.present, ...h.future],
    openKey: null,
  }
}

/** Step forward one undone entry. A no-op with nothing to redo. */
export const redo = <D>(h: History<D>): History<D> => {
  if (h.future.length === 0) return h
  const next = h.future[0] as D
  return {
    ...h,
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
    openKey: null,
  }
}

/** Has the saved part changed since the last `markSaved` (or since the start)? */
export const isDirty = <D>(h: History<D>): boolean => h.kind.saved(h.present) !== h.saved

/** Call after a successful save. */
export const markSaved = <D>(h: History<D>): History<D> => {
  const now = h.kind.saved(h.present)
  return h.saved === now ? h : { ...h, saved: now }
}

/** How many entries an undo can walk back, for "Undid (N more)". */
export const depth = <D>(h: History<D>): number => h.past.length

/**
 * Give every snapshot in the history the author lap, where it was flown on
 * that snapshot's course, so an undo back to the flown course still has it
 * (DEV-468: "any edit retires it and an undo brings it back"). One rule for
 * the desk and the bench: two copies could disagree about which lap survives.
 */
export const withAuthorLap = (h: History, lap: EditorDraft['authorLap']): History => {
  if (!lap) return h
  const give = (d: EditorDraft): EditorDraft => {
    const held = d.authorLap
    if (held && held.courseId === lap.courseId && held.seconds <= lap.seconds) return d
    return { ...d, authorLap: lap }
  }
  return { ...h, past: h.past.map(give), present: give(h.present), future: h.future.map(give) }
}
