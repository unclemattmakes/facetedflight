// tests/unit/credits-menu.test.ts: the credits. DEV-614, DEV-620, DEV-623.
//
// Held here:
//
//   1. The roll names everyone THIRD-PARTY-NOTICES.md names. Compared against THIRD-PARTY-NOTICES.md
//      itself, read off disk, rather than a list this test types.
//   2. The one attribution a licence REQUIRES (CRYSTAL, CC BY-SA 4.0) carries
//      author, title, licence and version, and that the copy is unmodified.
//   3. Every song the game LOADS is on the roll, title and artist: compared
//      against `SOUNDTRACK`, the list the music player is handed.
//   4. 2016's credits are on it, under their own heading.
//   5. One source: the hangar's CREDITS step is ONE table, standing the roll.
//   6. It is reachable: a row of OPTIONS in `app.ts`, and the title's line.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SOUNDTRACK } from '@/content/soundtrack'
import {
  activateCreditsRow,
  COPYRIGHT,
  CREDITS_2016,
  CREDITS_LINE_MAX,
  CREDITS_OPTION,
  CREDITS_TITLE,
  createCreditsMenu,
  creditsRoll,
  ROLL_PACE,
  titleLine,
} from '@/render/credits-menu'
import { creditsRollCard, doorStepCards } from '@/render/hangar-doors'
import { appFileWith, codeOnly } from './helpers/app-source'

const VERSION = 'v1.2.3'
const roll = creditsRoll(VERSION)
const said = roll.map((l) => l.text).join('\n')

describe('DEV-623: the roll says what THIRD-PARTY-NOTICES.md says', () => {
  const credits = fs.readFileSync('THIRD-PARTY-NOTICES.md', 'utf8')

  it("names every third-party item in THIRD-PARTY-NOTICES.md section 1's table", () => {
    const section = credits.slice(credits.indexOf('## 1.'), credits.indexOf('## 2.'))
    const names = [...section.matchAll(/^\| \*\*([^*]+)\*\*/gm)].map((m) => m[1] as string)
    expect(names.length, 'the table was found').toBeGreaterThan(0)
    for (const name of names) {
      expect(said.toLowerCase(), `${name} is on the roll`).toContain(name.toLowerCase())
    }
  })

  it("carries the CC BY-SA attribution CRYSTAL's licence requires", () => {
    expect(credits).toContain('© 2014 Felipe Munoz')
    const at = roll.findIndex((l) => l.text === 'CRYSTAL')
    const block = roll
      .slice(at, at + 3)
      .map((l) => l.text)
      .join(' ')
    expect(block).toContain('© 2014 Felipe Munoz')
    expect(block).toContain('CC BY-SA 4.0')
    expect(block).toContain('unmodified')
  })

  it('carries Bitter and its licence', () => {
    expect(said).toContain('Bitter')
    expect(said).toContain('SIL Open Font License 1.1')
  })

  it('carries the game, its maker, both years, the version', () => {
    expect(said).toContain(VERSION)
    expect(said).toContain(COPYRIGHT)
    expect(COPYRIGHT).toContain('© 2016 and 2026')
    expect(COPYRIGHT).not.toMatch(/again/)
  })
})

describe('DEV-623: every song the game loads, title and artist', () => {
  it('is SOUNDTRACK, in order, a title line then its artist', () => {
    expect(SOUNDTRACK.length).toBeGreaterThan(0)
    for (const track of SOUNDTRACK) {
      const i = roll.findIndex((l) => l.kind === 'name' && l.text === track.title)
      expect(i, `${track.title} is on the roll`).toBeGreaterThanOrEqual(0)
      expect(roll[i + 1]?.text, `${track.title}'s artist`).toBe(track.author)
    }
  })

  it('follows the list it is handed, not a list of its own', () => {
    const other = creditsRoll(VERSION, [{ title: 'Test Song', author: 'Test Artist' }])
    expect(other.map((l) => l.text)).toContain('Test Song')
    expect(other.map((l) => l.text)).not.toContain(SOUNDTRACK[0]?.title)
  })

  it('every track in SOUNDTRACK is a file under assets/audio/music', () => {
    for (const track of SOUNDTRACK) expect(track.src).toBe(`assets/audio/music/${track.id}.opus`)
  })
})

describe("DEV-623: 2016's credits, under their own heading", () => {
  it('has the heading, then every 2016 page', () => {
    // DEV-873 (Matt: "start with the 2016 credits"): it OPENS the roll, and
    // the anniversary's title follows it.
    const at = roll.findIndex((l) => l.text === 'Faceted Flight (2016)')
    expect(at).toBe(0)
    expect(roll.findIndex((l) => l.text === 'Faceted Flight')).toBeGreaterThan(at)
    const after = roll.slice(at).map((l) => l.text)
    for (const page of CREDITS_2016) {
      expect(after).toContain(page.heading)
      for (const name of page.names) expect(after).toContain(name)
    }
  })

  it("leaves out 2016's music pages: none of that music is in this build (DEV-833)", () => {
    expect(CREDITS_2016.map((p) => p.heading.toLowerCase())).not.toContain('music (2016)')
    for (const who of ['Roald Strauss', 'Robbie Dooley', 'Robson Cozendey']) {
      expect(said.includes(who), who).toBe(false)
    }
    // The game's own MUSIC section stays: it lists what the game loads.
    expect(roll.map((l) => l.text)).toContain('Music')
  })

  it('rolls at twice the old pace in every edition (DEV-833)', () => {
    expect(ROLL_PACE).toBeGreaterThanOrEqual(0.12)
  })

  it("keeps 2016's people", () => {
    for (const who of ['Matt Scott', 'Joe Harkins', 'Jean Simonet', 'Alice Duke']) {
      expect(said).toContain(who)
    }
  })
})

describe('DEV-623: the roll reads on a sheet', () => {
  it('holds every line to the sheet width', () => {
    for (const line of roll) {
      expect(line.text.length, `"${line.text}"`).toBeLessThanOrEqual(CREDITS_LINE_MAX)
    }
  })

  it('has one row, BACK, which A on row 0 takes; anywhere else A speeds the roll', () => {
    const menu = createCreditsMenu({ version: VERSION })
    menu.openPage()
    expect(menu.title).toBe(CREDITS_TITLE)
    expect(menu.rows.map((r) => r.id)).toEqual(['back'])
    expect(menu.roll).toEqual(roll)
    expect(menu.activate(-1)).toBe('none')
    expect(menu.open).toBe(true)
    expect(menu.activate(0)).toBe('back')
    expect(menu.open).toBe(false)
    expect(activateCreditsRow(3)).toBe('none')
  })
})

describe('DEV-623: the hangar shows the same roll on ONE table', () => {
  const input = { rooms: false, tv: false, firstVisit: false, linkRoom: null, roomNotice: null }
  it('the CREDITS step is one card, standing the roll, carrying the version', () => {
    const cards = doorStepCards('credits', { ...input, version: VERSION })
    expect(cards).toHaveLength(1)
    expect(cards[0]?.picture).toBe('roll')
    expect(cards[0]?.note).toBe(VERSION)
    expect(cards[0]).toEqual(creditsRollCard({ ...input, version: VERSION }))
  })

  it('the hangar stands the roll from creditsRoll, the one source', () => {
    const hangar = fs.readFileSync('src/render/hangar.ts', 'utf8')
    expect(hangar).toMatch(/createRollMark\(\s*creditsRoll\(/)
  })
})

describe('DEV-614 and DEV-621: reachable, and the footer is gone', () => {
  it('is a row of the OPTIONS page in app.ts, not of the root', () => {
    const app = codeOnly(appFileWith('const pauseOptions').text)
    const root = /const pauseOptions[\s\S]*?\n {2}\]\n/.exec(app)?.[0] ?? ''
    expect(root, 'found pauseOptions').toContain('OPTIONS_OPTION')
    expect(root).not.toContain('CREDITS_OPTION')
    // DEV-859: it is a door of the MORE page (the OPTIONS page's third door).
    const hubs = [...app.matchAll(/createOptionsMenu\([\s\S]*?\n {2}\)\n/g)].map((m) => m[0])
    expect(hubs.join('\n'), 'found the options pages').toContain('credits: CREDITS_OPTION')
    expect(CREDITS_OPTION.id).toBe('credits')
  })

  it('leaves no credit footer on the title page', () => {
    const html = fs.readFileSync('index.html', 'utf8')
    expect(html).not.toMatch(/<footer\b/)
    expect(html).not.toContain('id="credits"')
    expect(html).not.toContain('id="build-version"')
  })

  it('keeps one line at the title foot: the version, then the copyright', () => {
    expect(fs.readFileSync('index.html', 'utf8')).toContain('<p id="title-line"></p>')
    expect(fs.readFileSync('src/main.ts', 'utf8')).toContain('titleLine(BUILD_VERSION)')
    expect(titleLine(VERSION)).toBe(`${VERSION} · ${COPYRIGHT}`)
  })
})
