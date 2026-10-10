// DEV-611, DEV-872: the developer splash shows on every load, and every e2e
// spec skips it the way a player does: the base fixture presses Enter once the
// scene is loaded (`tests/e2e/fixtures/test.ts` says why that is a player's
// action and not a harness path). This keeps it true for the next spec somebody
// writes: one that imports Playwright's own `test` would meet the splash, and a
// press inside its hold is swallowed.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = 'tests/e2e'
const specs = readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'))
const read = (f: string): string => readFileSync(`${DIR}/${f}`, 'utf8')

/** Where a spec's `test` may come from: the suite's base, or the XR profile's, which skips too. */
const BASES = ["'./fixtures/test'", "'./fixtures/xr-browser'"]

describe("the suite's base test (DEV-611)", () => {
  it('finds the specs it guards', () => {
    expect(specs.length).toBeGreaterThan(100)
  })

  it('every spec takes `test` from a base that skips the splash', () => {
    const strays = specs.filter((f) => {
      const line = /^import \{[^}]*\btest\b[^}]*\} from ('[^']+')/m.exec(read(f))
      return line === null || !BASES.includes(line[1] as string)
    })
    expect(strays).toEqual([])
  })

  it('every context a spec builds itself skips it too', () => {
    const unskipped = specs.filter((f) => {
      const text = read(f)
      const built = text.split('browser.newContext(').length - 1
      const skipped = text.split('await skipSplash(').length - 1
      return skipped < built
    })
    expect(unskipped).toEqual([])
    expect(readFileSync(`${DIR}/fixtures/xr-browser.ts`, 'utf8')).toContain(
      'await skipSplash(context)',
    )
  })

  it('skips with a press the game accepts, not with a stored flag', () => {
    const text = readFileSync(`${DIR}/fixtures/test.ts`, 'utf8')
    expect(text).toContain("key: 'Enter'")
    expect(text).toContain('titleReady')
    expect(text).not.toMatch(/sessionStorage|localStorage|splash\.seen/)
    // The game honours no switch for it either.
    expect(readFileSync('src/boot/dev-splash.ts', 'utf8')).not.toMatch(
      /sessionStorage|localStorage/,
    )
  })
})
