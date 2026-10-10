// tools/net/write-lap-courses.mjs — rebuild `content/lap-courses.json`. DEV-372.
//
//   node tools/net/write-lap-courses.mjs
//
// The artefact is built by TypeScript (`src/net/lap-courses-build.ts`), which
// reads levels through `game/mission.ts`'s `courseGates` and the constants
// sheet through `@/` aliases. A plain `node` script cannot import either, so
// this runs the ONE test that already builds it — `tests/unit/lap-courses.test.ts`
// — with `LAP_COURSES_WRITE=1`, which writes the bytes before comparing them.
// One builder, one set of imports, and the write path cannot drift from the
// check path because it IS the check path.
//
// Run it after changing a Ring Attack level, an edition's `gameplay` block, a
// HoverJet speed constant or `LAP_RULES_EPOCH`, and commit the new file. A
// changed `rules` string starts that board again (`src/net/lap-courses.ts`).

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const vitestPkg = createRequire(import.meta.url).resolve('vitest/package.json')
const vitest = path.join(path.dirname(vitestPkg), 'vitest.mjs')

// Only the regenerate test: the others read the committed file through a module
// import made BEFORE the write, so in this run they would judge the old bytes.
const r = spawnSync(
  process.execPath,
  [vitest, 'run', 'tests/unit/lap-courses.test.ts', '-t', 'regenerates byte-identical'],
  { cwd: root, stdio: 'inherit', env: { ...process.env, LAP_COURSES_WRITE: '1' } },
)
process.exit(r.status ?? 1)
