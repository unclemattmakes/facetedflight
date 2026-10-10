#!/usr/bin/env node
// tools/test/e2e-env.mjs: run Playwright with E2E_MEASURE=1, so the @measure
// tier is collected too. A package script cannot set an env var portably
// (cmd.exe has no `VAR=1 cmd`), and the config reads this one.
//
//   node tools/test/e2e-env.mjs [playwright test args]    behaviour + @measure
//   pnpm e2e:all        the release gate's run
//   pnpm e2e:measure    only the @measure tests (add --grep to narrow further)
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { REPO } from './import-graph.mjs'

// Resolved the way Node would from the repo, so a worktree under .claude/worktrees
// finds the main checkout's install when it has none of its own.
const cli = createRequire(path.join(REPO, 'package.json')).resolve('@playwright/test/cli')
const r = spawnSync(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
  cwd: REPO,
  stdio: 'inherit',
  env: { ...process.env, E2E_MEASURE: '1' },
})
process.exit(r.status ?? 1)
