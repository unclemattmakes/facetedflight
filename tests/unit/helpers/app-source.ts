// tests/unit/helpers/app-source.ts — `boot/app.ts` as TEXT, wherever its code
// now lives. APP-SPLIT phase 0 (`docs/plan/APP-SPLIT.md`).
//
// NOT a `.test.ts`, so vitest does not collect it. Its own guard is
// `tests/unit/app-source.test.ts`.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// A few dozen unit tests read `src/boot/app.ts` off disk and assert on its
// text (`app-source.test.ts` sweeps for any that still do it by hand), because the wiring they guard lives in a closure no unit test can
// construct. That was sound while the closure was one file. The split moves
// its code into `src/boot/app/`, and a guard that reads ONE file by name then
// fails in one of two ways:
//
//   * loudly, when the text it requires has moved out. That is safe, and it is
//     noise in every slice;
//   * SILENTLY, when the text it forbids has moved out. *"app.ts imports nothing
//     from src/editor/ but types"* stays green while a new module beside it
//     imports the editor statically, and *"exactly one `xrSelect.take(`"* stays
//     green while a second one sits in another file. A negative assertion over
//     a file that no longer holds the code is a gate measuring nothing.
//
// So the guards read the TREE: the entry file and everything under
// `src/boot/app/`. A "contains" or a "does not contain" or a count is then
// true of the code wherever it went, which is the only thing it was ever
// meant to be about.
//
// ── Order is the one thing a concatenation cannot answer ─────────────────
//
// `indexOf(a) < indexOf(b)` over a concatenation of several files compares
// FILE ORDER the moment `a` and `b` live in different files — true or false
// by alphabet, and green either way it happens to fall. So any guard about
// ORDER, or that slices the text between two anchors, goes through
// `appFileWith` (the ONE file that holds its anchor) and `inOrder` (every
// anchor found, each after the last, in that file). When a slice of the split
// separates two anchors, those throw — and the guard is re-expressed as call
// order in the module that now owns it, never deleted (APP-SPLIT §6 rule 6).

import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './repo-root'
import { isTsAny, walkTree } from './source-tree'

/** The closure's original home, and the composition root once the split is done. */
export const APP_ENTRY = 'src/boot/app.ts'
/** Where the split moves the closure's code (APP-SPLIT §3). */
export const APP_DIR = 'src/boot/app'

export interface AppFile {
  /** Repo-relative, forward slashes. */
  readonly file: string
  readonly text: string
}

const rel = (abs: string): string => path.relative(REPO, abs).split(path.sep).join('/')

/**
 * Every file the closure's code can live in: the entry first, then
 * `src/boot/app/**` sorted. Read on every call, never cached at module scope,
 * so a guard that calls it inside its `it` sees the disk as it is then.
 */
export const appFiles = (): readonly AppFile[] => {
  const entry = path.join(REPO, APP_ENTRY)
  const rest = walkTree(path.join(REPO, APP_DIR), { match: isTsAny, optional: true }).sort((a, b) =>
    rel(a).localeCompare(rel(b)),
  )
  return [entry, ...rest].map((abs) => ({ file: rel(abs), text: fs.readFileSync(abs, 'utf8') }))
}

/**
 * The tree as one string, for "contains", "does not contain" and counts.
 *
 * Each file starts on a line of its own, so a pattern anchored at a line start
 * (`^import`, `\nimport `) still sees the first line of every file. Do NOT use
 * positions in this string to argue order or to slice between two anchors:
 * see the header, and use `appFileWith` + `inOrder` for that.
 */
export const appSource = (): string =>
  appFiles()
    .map((f) => f.text)
    .join('\n')

const holds = (text: string, anchor: string | RegExp): boolean =>
  typeof anchor === 'string'
    ? text.includes(anchor)
    : new RegExp(anchor.source, anchor.flags.replace('g', '')).test(text)

/**
 * The one file in `files` that holds `anchor`. Throws when none does, or when
 * more than one does — an anchor that names two places cannot tell a guard
 * which one it meant. Exported over an explicit list so its own test can give
 * it two files today, while the tree is still one.
 */
export const fileWithIn = (files: readonly AppFile[], anchor: string | RegExp): AppFile => {
  const found = files.filter((f) => holds(f.text, anchor))
  if (found.length === 0) {
    throw new Error(`app-source: no file under ${APP_ENTRY} or ${APP_DIR}/ holds ${String(anchor)}`)
  }
  if (found.length > 1) {
    throw new Error(
      `app-source: ${String(anchor)} is in ${found.length} files (${found
        .map((f) => f.file)
        .join(', ')}) — pick an anchor that names one place`,
    )
  }
  return found[0] as AppFile
}

/** `fileWithIn` over the live tree. */
export const appFileWith = (anchor: string | RegExp): AppFile => fileWithIn(appFiles(), anchor)

/**
 * Where each anchor sits in `text`, each searched for AFTER the one before.
 * Throws naming the first anchor that is missing, or that only occurs before
 * its predecessor — so a guard about order cannot pass on a `-1`.
 */
export const inOrder = (text: string, anchors: readonly string[]): number[] => {
  const at: number[] = []
  let from = 0
  for (const anchor of anchors) {
    const i = text.indexOf(anchor, from)
    if (i < 0) {
      const anywhere = text.indexOf(anchor)
      throw new Error(
        anywhere < 0
          ? `app-source: ${JSON.stringify(anchor)} is not in this file`
          : `app-source: ${JSON.stringify(anchor)} occurs only BEFORE ${JSON.stringify(
              anchors[at.length - 1],
            )}`,
      )
    }
    at.push(i)
    from = i + anchor.length
  }
  return at
}

/**
 * The split's one piece of plumbing, read through. A module the closure's code
 * moved to (APP-SPLIT phases 3 and 4) reads each binding the closure still
 * owns as `ctx.name`: a getter over the SAME binding the closure called
 * `name` (APP-SPLIT §6 rule 1). A guard whose pattern names such a binding
 * matches moved code through this, so `if (launchSpec) …` in the closure and
 * `if (ctx.launchSpec) …` in a module are one claim. It only ever REMOVES the
 * `ctx.` prefix, so a "does not contain" over it is at least as strict as over
 * `appSource()`.
 *
 * Phase 3's owner records are the same plumbing: a binding the closure called
 * `flight` is `handles.flight` once the world's handles are one record. Each
 * record joins `PLUMBING_RECORDS` in the step that introduces it, and only
 * then, so a prefix that is still an ordinary name elsewhere is never removed.
 */
export const PLUMBING_RECORDS: readonly string[] = [
  'ctx',
  'handles',
  'run',
  'router',
  'pause',
  'pilot',
]

const PLUMBING = new RegExp(`(?<![\\w$.])(?:${PLUMBING_RECORDS.join('|')})\\.`, 'g')

export const readThroughCtx = (text: string): string => text.replace(PLUMBING, '')

/** `appSource()`, read through the plumbing (`readThroughCtx`). */
export const appSourceThroughCtx = (): string => readThroughCtx(appSource())

/** `appFileWith`, over the tree read through the plumbing: the file's text comes back read through too. */
export const appFileThroughWith = (anchor: string | RegExp): AppFile =>
  fileWithIn(
    appFiles().map((f) => ({ file: f.file, text: readThroughCtx(f.text) })),
    anchor,
  )

/** Block and line comments out, for guards that must not be answered by prose (DEV-287). */
export const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
