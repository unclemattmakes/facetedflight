/**
 * `tools/test/e2e-baseline.mjs`: the cleanup half of `run`, against real
 * links on this host's filesystem (junctions on Windows, directory symlinks on
 * POSIX) and a real throwaway git repository.
 *
 * Found 2026-10-01 recording the app.ts split's baseline (APP-SPLIT §10 row
 * 0.4): on Windows `git worktree remove --force` deleted the baseline
 * worktree's `.git`, then failed on "Directory not empty" over ~191 pnpm
 * junctions plus `public/`, which is the MAIN checkout's asset tree. The
 * folder left behind made git answer with the main checkout's HEAD, and the
 * next `run` of that ref refused to start. The property that matters is the
 * one a followed link breaks: the folder goes and the TARGET keeps its files.
 * So every assertion here is about what is still on disk afterwards, outside
 * the folder, counted by a walk that does not follow links itself.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  baselineTreeState,
  clearBaselineTree,
  findLinks,
  removeTreeSafely,
} from '../../tools/test/e2e-baseline.mjs'

/** A junction on Windows (no privilege needed), a directory symlink elsewhere. */
const link = (target: string, at: string) => {
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}

const write = (file: string, body = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

/** Every regular file under `root`, relative, by a walk that never follows a link. */
const filesUnder = (root: string): string[] => {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isFile()) out.push(path.relative(root, p))
      else if (entry.isDirectory() && !fs.lstatSync(p).isSymbolicLink()) stack.push(p)
    }
  }
  return out.sort()
}

const scratch: string[] = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff2-tree-cleanup-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  // Each scratch root is removed the same safe way, so a failed assertion
  // above cannot turn this into the recursive delete the tool exists to avoid.
  for (const dir of scratch.splice(0)) removeTreeSafely(dir)
})

/**
 * A stand-in for the main checkout (`shared`: an asset tree and a
 * `node_modules/.bin`) and a baseline folder (`tree`) shaped like the
 * leftover: pnpm-style links INSIDE the folder, links OUT to the shared
 * trees, one link to the whole stand-in checkout buried deep, and files.
 */
const buildLeftover = (root: string) => {
  const shared = path.join(root, 'main')
  write(path.join(shared, 'public', 'assets', 'terrain.glb'))
  write(path.join(shared, 'public', 'assets', 'audio', 'music', 'one.opus'))
  write(path.join(shared, 'node_modules', '.bin', 'vitest'))
  write(path.join(shared, 'node_modules', 'three', 'package.json'))

  const tree = path.join(root, 'main', '.claude', 'worktrees', 'e2e-baseline-0123456789ab')
  write(path.join(tree, 'package.json'))
  write(path.join(tree, 'test-results', 'a', 'trace.zip'))
  const pkg = path.join(tree, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg')
  write(path.join(pkg, 'index.js'))
  link(pkg, path.join(tree, 'node_modules', 'pkg'))
  link(pkg, path.join(tree, 'node_modules', '.pnpm', 'other@2.0.0', 'node_modules', 'pkg'))
  link(path.join(shared, 'public'), path.join(tree, 'public'))
  link(path.join(shared, 'node_modules'), path.join(tree, 'node_modules', '.shared'))
  link(shared, path.join(tree, 'deep', 'a', 'b', 'whole-checkout'))
  return { shared, tree }
}

describe('removeTreeSafely, over real links', () => {
  it('finds every link and lists nothing from behind one', () => {
    const { shared, tree } = buildLeftover(tmp())
    const links = findLinks(tree).map((p) => path.relative(tree, p))
    expect(links.sort()).toEqual(
      [
        path.join('deep', 'a', 'b', 'whole-checkout'),
        path.join('node_modules', '.pnpm', 'other@2.0.0', 'node_modules', 'pkg'),
        path.join('node_modules', '.shared'),
        path.join('node_modules', 'pkg'),
        'public',
      ].sort(),
    )
    // The stand-in checkout CONTAINS the tree, so a walk that followed
    // `whole-checkout` would loop; one that followed `public` would list assets.
    expect(findLinks(tree).some((p) => p.startsWith(path.join(shared, 'public')))).toBe(false)
  })

  it('removes the folder and leaves every link target with all its files', () => {
    const { shared, tree } = buildLeftover(tmp())
    // Taken with the tree in place, so these are the shared files plus the
    // tree's own: what must remain is exactly the shared half.
    const before = filesUnder(shared).filter((f) => !f.startsWith('.claude'))
    expect(before).toEqual(
      [
        path.join('node_modules', '.bin', 'vitest'),
        path.join('node_modules', 'three', 'package.json'),
        path.join('public', 'assets', 'audio', 'music', 'one.opus'),
        path.join('public', 'assets', 'terrain.glb'),
      ].sort(),
    )

    removeTreeSafely(tree)

    expect(fs.existsSync(tree)).toBe(false)
    expect(filesUnder(shared).filter((f) => !f.startsWith('.claude'))).toEqual(before)
  })

  it('is a no-op for a path that is not there', () => {
    expect(() => removeTreeSafely(path.join(tmp(), 'never-made'))).not.toThrow()
  })

  it('takes a root that is itself a link off without touching its target', () => {
    const root = tmp()
    write(path.join(root, 'target', 'keep.txt'))
    link(path.join(root, 'target'), path.join(root, 'alias'))
    removeTreeSafely(path.join(root, 'alias'))
    expect(fs.existsSync(path.join(root, 'alias'))).toBe(false)
    expect(filesUnder(path.join(root, 'target'))).toEqual(['keep.txt'])
  })
})

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('baselineTreeState and clearBaselineTree, in a real repository', () => {
  /** A repository with two commits, the shared trees, and a baseline worktree at the first. */
  const repo = () => {
    const main = path.join(tmp(), 'main')
    fs.mkdirSync(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'one')
    const first = git(main, 'rev-parse', 'HEAD')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'two')
    const head = git(main, 'rev-parse', 'HEAD')
    write(path.join(main, 'public', 'assets', 'terrain.glb'))
    write(path.join(main, 'node_modules', '.bin', 'vitest'))
    const tree = path.join(main, '.claude', 'worktrees', `e2e-baseline-${first.slice(0, 12)}`)
    git(main, 'worktree', 'add', '-q', '--detach', tree, first)
    link(path.join(main, 'public'), path.join(tree, 'public'))
    link(path.join(main, 'node_modules'), path.join(tree, 'node_modules', '.shared'))
    return { main, tree, first, head }
  }

  it('reads a live worktree as ours at its sha and other at any other', () => {
    const { tree, first, head } = repo()
    expect(baselineTreeState(tree, first)).toEqual({ state: 'ours' })
    expect(baselineTreeState(tree, head)).toEqual({ state: 'other', head: first })
  })

  it('reads a folder without its .git as a leftover, though git inside it answers', () => {
    const { tree, first, head } = repo()
    // What `git worktree remove` left on Windows: `.git` gone, the rest kept.
    fs.rmSync(path.join(tree, '.git'))
    // The premise of the bug: git walks up and answers with the MAIN HEAD.
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(head)
    expect(baselineTreeState(tree, first)).toEqual({ state: 'leftover' })
  })

  it('clears the worktree and its registration, and the shared trees keep their files', () => {
    const { main, tree } = repo()
    const assets = filesUnder(path.join(main, 'public'))
    const bin = filesUnder(path.join(main, 'node_modules'))
    expect(git(main, 'worktree', 'list', '--porcelain')).toContain('e2e-baseline-')

    clearBaselineTree(main, tree)

    expect(fs.existsSync(tree)).toBe(false)
    expect(git(main, 'worktree', 'list', '--porcelain')).not.toContain('e2e-baseline-')
    expect(filesUnder(path.join(main, 'public'))).toEqual(assets)
    expect(filesUnder(path.join(main, 'node_modules'))).toEqual(bin)
    expect(assets).toEqual([path.join('assets', 'terrain.glb')])
  })
})
