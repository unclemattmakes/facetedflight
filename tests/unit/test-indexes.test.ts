// tests/unit/test-indexes.test.ts: the two generated indexes in docs/testing/ are current (DEV-966).
//
// docs/testing/TIERS.md's spec table and docs/testing/KNOWN-RED.md's call-site table are written by
// tools/test/gen-test-indexes.mjs from the tags and knownRed calls in tests/e2e. A spec added, a tag
// moved or a call shifted without rerunning it leaves the file stale, and this says which.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { present } from './helpers/checkout'
import { REPO } from './helpers/repo-root'

const HAVE =
  present('docs/testing/TIERS.md') &&
  present('docs/testing/KNOWN-RED.md') &&
  present('tools/test/gen-test-indexes.mjs')

describe.skipIf(!HAVE)('the generated test indexes', () => {
  it('are current: node tools/test/gen-test-indexes.mjs changes nothing', () => {
    const r = spawnSync(
      process.execPath,
      [path.join('tools', 'test', 'gen-test-indexes.mjs'), '--check'],
      {
        cwd: REPO,
        encoding: 'utf8',
      },
    )
    expect(r.stderr, 'the generator printed which file is stale').toBe('')
    expect(r.status).toBe(0)
  })
})
