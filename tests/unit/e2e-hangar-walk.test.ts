/**
 * The e2e menu walk agrees with the menu, checked WITHOUT a browser.
 *
 * ── Why this test exists, and what it would have caught ──────────────────
 *
 * DEV-203 made the level select four steps with fixed slots. Two e2e specs went
 * on pressing A three times and boarding nothing, and stayed red for a day
 * (DEV-222). Nothing noticed, for a reason that is structural rather than
 * careless: **CI does not run Playwright** and cannot — `public/assets/` needs
 * R2 credentials the workflow refuses to hold, and the suite is headed on
 * purpose because headless Chromium falls back to software WebGL. So a red e2e
 * spec is visible only to whoever chooses to run that file.
 *
 * But **neither of those failures was about a pixel.** They were about how many
 * steps the menu has — a fact the graph knows and a GPU has nothing to say
 * about. A fact like that does not need a browser; it needed one only because
 * the code that knew it happened to live there. This test takes that class back
 * to where it can be watched on every push: `git clone`, `pnpm install`, no
 * assets, no browser, no secrets.
 *
 * **It would have gone red the night DEV-203 landed**, without anyone running
 * Playwright, because the fixture's step list would have disagreed with
 * `HANGAR_VIEWS` the moment a fourth step appeared.
 *
 * That sentence is a claim, so it was CHECKED rather than asserted: both specs
 * were extracted at `134c654` — the commit before the repair — and fed to
 * `pressesBlind`, which fired on each. The loud counterparts below use
 * synthetic text, which proves the detector can object but not that it objects
 * to the thing that actually happened. The historical run is what closes that,
 * and it is recorded here rather than kept as a test, because pinning two
 * obsolete spec files into the tree to re-prove a settled fact is how fixtures
 * become archaeology.
 *
 * ── What it does NOT reach, stated so the guard is not mistaken for general ──
 *
 * DEV-222's third failure — `lookdev.spec.ts` reading its face count off the
 * last of TWO objects named `sky-dome` — is out of reach here and would be out
 * of reach of any obvious extension. Both domes come from ONE factory called
 * twice, so a static "is this name assigned in more than one place" check finds
 * a single assignment and passes, truthfully and uselessly. The guard that
 * works there is the one in the spec itself: assert the LENGTH of the lookup,
 * so an ambiguous probe fails instead of picking. That one is not CI-visible,
 * and saying so is better than implying this file covers it.
 *
 * So: one of DEV-222's three classes gets a CI guard, one gets a spec-level
 * assertion only, and the residue is genuinely pixels and genuinely a habit.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOOR_VIEWS, HANGAR_VIEWS } from '@/render/hangar'
import { REPO } from './helpers/repo-root'

const E2E = path.join(REPO, 'tests', 'e2e')
const FIXTURE = path.join(E2E, 'fixtures', 'hangar.ts')

/**
 * The view names `board()` walks, read out of the fixture's own source.
 *
 * Taken as TEXT rather than by importing the fixture, and that is deliberate:
 * `HANGAR_VIEWS` lives in `render/hangar.ts`, which imports three.js and
 * reaches `import.meta.glob` through the mission index. A Playwright fixture
 * that imported it could take the whole e2e COLLECTION down — one import edge
 * into that graph has done exactly that before, and a suite that collects zero
 * tests exits green-ish and proves nothing. So the value lives in one place,
 * the fixture spells it, and this file is what makes them agree.
 */
const viewsInBoard = (source: string): readonly string[] => {
  const open = source.indexOf('const steps = [')
  if (open === -1) return []
  const close = source.indexOf('] as const', open)
  if (close === -1) return []
  return [...source.slice(open, close).matchAll(/\[\s*'([a-z]+)'\s*,/g)].map((m) => m[1] as string)
}

/** Every `.spec.ts` under `tests/e2e`, with its source. */
const specs = (): readonly { name: string; source: string }[] =>
  fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => ({ name: f, source: fs.readFileSync(path.join(E2E, f), 'utf8') }))

/**
 * Does this source press confirm REPEATEDLY without ever asking what it is
 * aimed at?
 *
 * Two shapes, because DEV-222's two stale specs used one each: `fade.spec.ts`
 * wrote three unrolled `hold(page, 'Enter')` calls in a row, and
 * `briefing.spec.ts` wrapped one in a counted loop. A sweep that looked only
 * for loops cleared `fade` — I ran that sweep, cleared that file, and it failed
 * ten minutes later.
 *
 * A file that consults `hangarAim` is exempt: it is aiming, whatever else it
 * does.
 *
 * ── The bounded retry, and why the loop test is not just "a loop" ────────
 *
 * `launch-ride-on-switch.spec.ts` has a counted loop with a press in it:
 *
 *     for (let i = 0; i < 4; i++) { if (await done()) return true; await hold(page, 'Enter') }
 *
 * That matches the SYNTAX and is not the defect — it checks a predicate each
 * turn and leaves early. A blind walk is *presses with nothing asked between
 * them*, so a body carrying an `expect(`, a `return` or a `break` is exempt on
 * its own terms. It matters that this is decided by the BODY: the file also
 * happens to mention `hangarAim`, so the file-level exemption above would have
 * cleared it anyway — by luck, and the luck would run out the day that file
 * stopped aiming elsewhere. A detector that gets the right answer for the wrong
 * reason is the thing this whole ledger row is about.
 */
const pressesBlind = (source: string): boolean => {
  if (source.includes('hangarAim')) return false
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
  const isEnter = (l: string) => /^await hold\(page, 'Enter'\)/.test(l)
  for (let i = 1; i < lines.length; i++) {
    if (isEnter(lines[i] as string) && isEnter(lines[i - 1] as string)) return true
  }
  // A counted loop that presses confirm and asks nothing between presses.
  return [...source.matchAll(/for \(let \w+ = 0; \w+ < \d+; \w+\+\+\) \{([^}]*)/gs)].some((m) => {
    const body = m[1] as string
    return body.includes("'Enter'") && !/\bexpect\(|\breturn\b|\bbreak\b/.test(body)
  })
}

describe('the e2e menu walk agrees with the menu', () => {
  it('walks exactly the steps `HANGAR_VIEWS` declares, in order, behind the doors', () => {
    // DEV-558: the room's FIRST step, the doors (`DOOR_VIEWS[0]`), stands in
    // front of the walk, and `board()` presses SINGLE PLAYER on it.
    const source = fs.readFileSync(FIXTURE, 'utf8')
    expect(viewsInBoard(source)).toEqual([DOOR_VIEWS[0], ...HANGAR_VIEWS])
  })

  // The loud counterpart. A detector nobody has seen object is a detector that
  // might match nothing at all — which is how this project once shipped a hash
  // check reporting "0/0 ready verified" and counted it as a pass.
  it('objects to the three-step walk that DEV-203 made stale', () => {
    const stale = `
      const steps = [
        ['vehicles', course.vehicle],
        ['ranks', course.rank],
        ['courses', course.id],
      ] as const
    `
    expect(viewsInBoard(stale)).toEqual(['vehicles', 'ranks', 'courses'])
    expect(viewsInBoard(stale)).not.toEqual([...HANGAR_VIEWS])
  })

  it('finds no step list at all in a source that has none', () => {
    expect(viewsInBoard('const other = [1, 2, 3]')).toEqual([])
  })
})

describe('no spec presses confirm blind through the menu', () => {
  it('every e2e spec either aims or does not repeat a press', () => {
    const offenders = specs()
      .filter((s) => pressesBlind(s.source))
      .map((s) => s.name)
    expect(offenders, 'specs pressing Enter repeatedly without aiming').toEqual([])
  })

  it('objects to both shapes DEV-222 actually found', () => {
    // `fade.spec.ts`: unrolled, consecutive.
    expect(
      pressesBlind(`await hold(page, 'Enter')\nawait hold(page, 'Enter')\n`),
      'consecutive presses',
    ).toBe(true)
    // `briefing.spec.ts`: a counted loop.
    expect(
      pressesBlind(`for (let i = 0; i < 3; i++) {\n  await page.keyboard.down('Enter')\n}`),
      'a counted loop of presses',
    ).toBe(true)
    // And a file that aims is exempt however it presses.
    expect(
      pressesBlind(`await hangarAim(page)\nawait hold(page, 'Enter')\nawait hold(page, 'Enter')\n`),
      'a file that aims',
    ).toBe(false)
  })

  // The precision half, and it is the one that says the detector encodes the
  // PROPERTY rather than the syntax. Both of these are counted loops with a
  // press inside; only the first presses blind.
  it('lets a bounded retry through and still catches the blind walk', () => {
    expect(
      pressesBlind(
        `for (let i = 0; i < 4; i++) { if (await done()) return true; await hold(page, 'Enter') }`,
      ),
      'a loop that checks a predicate and leaves early',
    ).toBe(false)
    expect(
      pressesBlind(
        `for (let i = 0; i < 4; i++) { expect(await up(page)).toBe(true); await hold(page, 'Enter') }`,
      ),
      'a loop that asserts between presses',
    ).toBe(false)
    expect(
      pressesBlind(`for (let i = 0; i < 4; i++) { await hold(page, 'Enter'); await wait(page) }`),
      'a loop that asks nothing',
    ).toBe(true)
  })
})
