#!/usr/bin/env node
// tools/test/run-slow.mjs: `pnpm test:slow`. Runs ONLY the files in
// tests/slow.list.json, the ones `pnpm test` leaves out (vitest.config.ts reads
// the same list). The tier is chosen by an env var so the one config serves
// both, and a Windows shell needs no `VAR=x cmd` syntax. Extra arguments go to
// vitest. The exit code is vitest's own.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// Resolved the way Node resolves it, so a worktree with no node_modules of its
// own finds the main checkout's (tools/test/tiered.mjs joins the path by hand).
const vitest = path.join(
  path.dirname(createRequire(`${repo}/`).resolve('vitest/package.json')),
  'vitest.mjs',
)
const r = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, FF2_TEST_TIER: 'slow' },
})
process.exit(r.status ?? 1)
