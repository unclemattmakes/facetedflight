// The suite's server origin and browser channel live in ONE place,
// `tests/e2e/fixtures/server.ts`, which `playwright.config.ts` imports. Nine
// specs once carried private copies and the copies drifted from the config
// (they lost its `!CI` half). This keeps the next spec from writing a tenth:
// a spec that opens its own browser imports the constants.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = 'tests/e2e'
const files = [
  ...readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${DIR}/${f}`),
  ...readdirSync(`${DIR}/fixtures`)
    .filter((f) => f.endsWith('.ts') && f !== 'server.ts')
    .map((f) => `${DIR}/fixtures/${f}`),
]

/** A read of one of the three variables with a fallback after it: the shape of a private copy. */
const COPY = /process\.env\.E2E_(PORT|HOST|CHANNEL)\s*\?\?/

describe('the e2e server constants have one home', () => {
  it('finds the files it guards', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no spec or fixture re-derives the port, host or channel', () => {
    const copies = files.filter((f) => COPY.test(readFileSync(f, 'utf8')))
    expect(copies).toEqual([])
  })

  it('the config reads them from the fixture', () => {
    const config = readFileSync('playwright.config.ts', 'utf8')
    expect(config).toContain("from './tests/e2e/fixtures/server'")
    expect(COPY.test(config)).toBe(false)
  })

  it('the fixture still owns the rule, with the CI half the copies lost', () => {
    const server = readFileSync(`${DIR}/fixtures/server.ts`, 'utf8')
    expect(COPY.test(server)).toBe(true)
    expect(server).toContain("process.platform === 'win32' && !process.env.CI")
  })
})
