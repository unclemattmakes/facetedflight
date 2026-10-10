// tests/unit/helpers/source-tree.ts: walk the repository's own files, for the
// guards that sweep `src/` as text (TS-11 in docs/plan/code-reuse/tests.md).
//
// Eighteen tests each wrote their own recursive `readdirSync` and each chose
// its own filter, and the filters are LOAD-BEARING: `room-names` and
// `lap-server-bundle` keep `.d.ts` files, `source-bytes` skips dot-directories
// and `node_modules`, `privacy-page` takes four extensions. So nothing here is
// a default a caller can fall into by accident: every filter is an argument,
// and the two named listings below say in their NAMES which side of `.d.ts`
// they are on.
//
// ONLY THE WALK LIVES HERE. What a guard does with a file (strip comments,
// match a pattern, count a token) stays in the guard, and a guard's own
// marker strings stay out of this file's prose (a guard that classifies by
// substring is answered by comments that spell its markers).
//
// Order is the order `readdirSync` returns, depth first, the way every copy
// returned it: files and subdirectories interleaved, nothing sorted. A guard
// that needs an order sorts for itself.
//
// Directories are read through `Dirent`, so a symlinked directory is NOT
// followed (as in the copies that used `entry.isDirectory()`). The two copies
// that used `statSync` followed links; neither walks a tree that holds one.

import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './repo-root'

export { REPO }

export interface WalkOptions {
  /** True for a FILE NAME (not a path) the caller wants returned. */
  match: (name: string) => boolean
  /** True for a DIRECTORY NAME the walk must not enter. Default: none. */
  skipDir?: (name: string) => boolean
  /** A missing `dir` yields `[]` instead of throwing. Default: throw, loudly. */
  optional?: boolean
}

/** Every file under `dir` (absolute) whose name `match` accepts, as absolute paths. */
export const walkTree = (dir: string, opts: WalkOptions): string[] => {
  const out: string[] = []
  if (opts.optional && !fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!opts.skipDir?.(entry.name)) out.push(...walkTree(p, { ...opts, optional: false }))
    } else if (opts.match(entry.name)) out.push(p)
  }
  return out
}

/** `*.ts` and NOT `*.d.ts`. */
export const isTsSource = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.d.ts')

/** `*.ts`, declaration files included. */
export const isTsAny = (name: string): boolean => name.endsWith('.ts')

type Rest = Omit<WalkOptions, 'match'>

/** Every `.ts` source file (no declaration files) under an absolute directory. */
export const listTs = (dir: string, rest: Rest = {}): string[] =>
  walkTree(dir, { ...rest, match: isTsSource })

/** Every `.ts` file under an absolute directory, declaration files INCLUDED. */
export const listTsWithDts = (dir: string, rest: Rest = {}): string[] =>
  walkTree(dir, { ...rest, match: isTsAny })

/** Every `.ts` source file (no declaration files) under `src/`, as absolute paths. */
export const walkSrc = (): string[] => listTs(path.join(REPO, 'src'))
