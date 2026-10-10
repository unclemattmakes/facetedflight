#!/usr/bin/env node
/**
 * install.mjs — point this clone's git at .githooks/.
 *
 * Git does NOT clone hooks. Without this, every fresh clone of Faceted Flight 2 has the asset
 * denylist sitting in the tree, visible, documented, and doing nothing at all — which is the
 * worst state to be in, because the repo looks protected.
 *
 * Wire it into package.json so `pnpm install` does it for you:
 *
 *     "scripts": { "prepare": "node .githooks/install.mjs" }
 *
 * or run it directly. Equivalent to `git config core.hooksPath .githooks`.
 *
 * NEVER FAILS THE INSTALL. A missing git, a tarball with no `.git`, or a directory that has not
 * been `git init`-ed yet are all normal situations — this reports and exits 0. A broken
 * `pnpm install` would just get the script deleted, and then nobody has a hook at all.
 *
 * See ASSET-PROVENANCE.md §5 for what the hook enforces and why.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DESIRED = '.githooks'

function say(msg) {
  process.stdout.write(`install-hooks: ${msg}\n`)
}

function tryGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const inWorkTree = tryGit(['rev-parse', '--is-inside-work-tree'])
if (inWorkTree !== 'true') {
  say('not a git work tree yet — nothing to wire up. Re-run after `git init`.')
  process.exit(0)
}

const current = tryGit(['config', '--get', 'core.hooksPath'])
if (current === DESIRED) {
  say(`already wired (core.hooksPath = ${DESIRED}).`)
  process.exit(0)
}

if (current && current !== DESIRED) {
  say(`core.hooksPath is currently "${current}" — overriding it with "${DESIRED}".`)
}

if (tryGit(['config', 'core.hooksPath', DESIRED]) === null) {
  say(`could not set core.hooksPath. Run it yourself: git config core.hooksPath ${DESIRED}`)
  process.exit(0)
}

say(`core.hooksPath = ${DESIRED}. The asset denylist now runs before every commit.`)
say(
  'What it blocks and why: ASSET-PROVENANCE.md · rules: node .githooks/check-denylist.mjs --list-rules',
)
