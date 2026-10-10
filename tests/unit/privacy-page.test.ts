// tests/unit/privacy-page.test.ts — what /privacy says now that rooms and the
// course editor ship. DEV-470 (D36).
//
// D36 commits the release to a privacy page that states what a room and a
// shared course actually send. The page is written from the code: every
// number is a constant interpolated, and every storage name is written in
// `net/privacy-page.ts` (the Functions bundle may not import the game) and
// held EQUAL here to the name the game uses. The numbers are pinned as the
// sentences a reader sees, so moving a constant is an edit somebody makes to
// this file on purpose — `room-server.test.ts`'s pattern for the pose rate and
// the 30 seconds.
//
// And the premises, where one line of code can hold them: a course link puts
// the course in the fragment only; a course cannot carry a field about its
// author; a lap on a player course is never offered to the lap server; and a
// room's kept lap is served to anyone who names the room, with no seat asked.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heightmapSha } from '@/content/island-map'
import {
  canonicalPlayerCourse,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  validatePlayerCourse,
} from '@/content/player-course'
import {
  courseFile,
  courseLink,
  courseLinkable,
  PLAYER_COURSE_WIRE,
  readCourseFile,
} from '@/content/player-course-wire'
import { DRAFT_INDEX_KEY } from '@/editor/core/drafts'
import { COURSE_LIBRARY_DB, createCourseLibrary, memoryBackend } from '@/game/course-library'
import { LOCAL_LAP_RULES } from '@/game/ghost-store'
import { shareable } from '@/game/lap-share'
import { ROOM_PAGE_STORE } from '@/game/room-client'
import {
  AttemptTally,
  bugRow,
  ErrorTally,
  STATS_ATTEMPTS_KEY,
  STATS_OPT_OUT_KEY,
  VisitTally,
} from '@/game/stats-tally'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS } from '@/net/handles'
import {
  PRIVACY_BROWSER_STORES,
  PRIVACY_ROOM_CODE_LENGTH,
  PRIVACY_STATS_KEEP_MONTHS,
  PRIVACY_STATS_KINDS,
  PRIVACY_STATS_SMALLEST,
  PRIVACY_STATS_STORE,
  PRIVACY_TV_RESULTS_MINUTES,
  PRIVACY_VISIT_COUNTER,
  PRIVACY_VISIT_SCRIPT_HOST,
  PRIVACY_WATCH_DELAY_SECONDS,
  privacyPage,
  statsFieldList,
} from '@/net/privacy-page'
import { PRIVACY_STATS_SCRIPT_SOURCE } from '@/net/privacy-script'
import { fetchRoomLap, type RoomJudgeLink } from '@/net/room-lap'
import { BROADCAST_DELAY_MS, ROOM_CODE_LENGTH } from '@/net/room-protocol'
import { STATS_ERRORS_PER_VISIT, STATS_KINDS } from '@/net/stats-schema'
import { anonymiseText } from '@/net/tv-anon'
import { TvGuide } from '@/net/tv-guide'
import { TV_RESULTS_HOLD_MS } from '@/net/tv-protocol'
import { walkTree } from './helpers/source-tree'

/** The page as a reader sees it: the source's line breaks are not the page's. */
const page = (): string => privacyPage().replace(/\s+/g, ' ')

describe('DEV-470 — what /privacy says a room sends, and to whom', () => {
  it('states the code’s length and the viewers’ delay, from the room’s constants', () => {
    expect(PRIVACY_ROOM_CODE_LENGTH).toBe(ROOM_CODE_LENGTH)
    expect(PRIVACY_ROOM_CODE_LENGTH).toBe(7) // DEV-458: seven characters
    expect(PRIVACY_WATCH_DELAY_SECONDS).toBe(BROADCAST_DELAY_MS / 1000)
    expect(PRIVACY_WATCH_DELAY_SECONDS).toBe(2) // DEV-436: two seconds behind
    const p = page()
    expect(p).toContain("It has a link and a 7-character code, and the code is the room's name")
    expect(p).toContain('anyone who has the link or the code can join')
    expect(p).toContain('to anyone watching the race about 2 seconds later')
    expect(p).toContain('sees the race about 2 seconds behind')
  })

  it('no longer says the link is the only way in, or that poses reach nobody else', () => {
    const p = page()
    expect(p).not.toContain('The link is the only way in')
    expect(p).not.toContain('and to nobody else')
  })

  it('names the tab’s code by the key the game keeps it under, and says a removed player stays out', () => {
    expect(PRIVACY_BROWSER_STORES.roomPage).toBe(ROOM_PAGE_STORE)
    const p = page()
    expect(p).toContain(`<code>${ROOM_PAGE_STORE}</code>`)
    expect(p).toContain('session storage')
    // DEV-542: made at the first join (`roomPageToken()` in `roomOpen`), not at the load.
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('made the first time you join one in that tab')
    expect(flat).not.toContain('made when the page loads')
    expect(p).toContain("The room's owner can remove a player")
    expect(p).toContain('refuses both, for as long as the room lasts')
  })

  it('says anyone with the room’s code can fetch a lap it keeps — and the judge asks no seat', async () => {
    expect(page()).toContain("Anyone who has the room's code can fetch a lap the room keeps")
    // The premise: `GET /api/room/<id>/lap?slot=` is answered with no seat token.
    const link = { lap: async () => 'the lap' } as unknown as RoomJudgeLink
    const answer = await fetchRoomLap(new Request('https://x/api/room/K7QX4M2/lap?slot=0'), link)
    expect(answer.status).toBe(200)
  })
})

describe('DEV-470 — what /privacy says about the courses players make', () => {
  it('names the library and the drafts by the names the game keeps them under', () => {
    expect(PRIVACY_BROWSER_STORES.courses).toBe(COURSE_LIBRARY_DB.name)
    expect(PRIVACY_BROWSER_STORES.drafts).toBe(DRAFT_INDEX_KEY)
    const p = page()
    expect(p).toContain(`IndexedDB database called <code>${COURSE_LIBRARY_DB.name}</code>`)
    expect(p).toContain(`<code>${DRAFT_INDEX_KEY}</code>`)
    expect(p).toContain(`<code>${PLAYER_COURSE_WIRE.fileExtension}</code>`)
    expect(p).toContain("Clearing this site's data in your browser removes all of them")
  })

  const course: PlayerCourse = {
    v: PLAYER_COURSE_VERSION,
    island: 'simonet',
    sky: 'int_01_hoverJet',
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: {
      points: [
        [0, 120, 0],
        [0, 120, 800],
      ],
      gap: 200,
    },
    rings: [],
    start: { pos: [0, 100, -60], yaw: 180 },
    finish: { t: 1 },
    timeLimit: 120,
    name: [HANDLE_ADJECTIVES[0] as string, HANDLE_NOUNS[0] as string],
  }

  it('says a course link carries the course after the #, and the link does exactly that', async () => {
    expect(page()).toContain('carries the whole course after the <code>#</code>')
    const base = 'https://ff-10yr.pages.dev/'
    const url = new URL(await courseLink(course, base))
    // Nothing a browser sends: no query, and the address before the # is the page's own.
    expect(url.search).toBe('')
    expect(`${url.origin}${url.pathname}`).toBe(base)
    expect(url.hash.startsWith(`#${PLAYER_COURSE_WIRE.fragmentKey}=`)).toBe(true)
  })

  it('says a course holds nothing about who made it, and the format refuses any such field', () => {
    expect(page()).toContain('It holds no handle and nothing else about who made it')
    // The canonical form — what a link and a file carry — has exactly these
    // fields, written key by key (`canonicalPlayerCourse`).
    expect(Object.keys(JSON.parse(canonicalPlayerCourse(course)) as object).sort()).toEqual([
      'finish',
      'island',
      'mode',
      'name',
      'path',
      'rings',
      'sky',
      'start',
      'timeLimit',
      'v',
      'vehicle',
    ])
    // DEV-475: the start is a PAD, a place and a heading, and the page says so.
    expect(page()).toContain('its start pad and finish')
    const canonical = JSON.parse(canonicalPlayerCourse(course)) as { start: object }
    expect(Object.keys(canonical.start).sort()).toEqual(['pos', 'yaw'])
    // DEV-476: the optional light, a sun and a tint, named on the page, and
    // nothing in it but those four numbers.
    // DEV-500: and the water level, one number.
    // DEV-504: and the placed props, each a library id and three numbers.
    expect(page().replace(/\s+/g, ' ')).toContain(
      "if its maker set them, the sun's height and direction, a colour tint, a water level " +
        "and the props its maker placed (which of the islands' own meshes, where, which way " +
        'round and how large)',
    )
    const propped = {
      ...course,
      props: [{ kind: 'cactus-tall-01', pos: course.start.pos, yaw: 30, scale: 3 }],
    } as typeof course
    const proppedCanonical = JSON.parse(canonicalPlayerCourse(propped)) as { props: object[] }
    expect(Object.keys(proppedCanonical.props[0] as object)).toEqual([
      'kind',
      'pos',
      'yaw',
      'scale',
    ])
    // DEV-501: the anchor, a flag and one height, named on the page.
    expect(page().replace(/\s+/g, ' ')).toContain(
      'its path and rings (and whether its first ring is anchored to the start pad, and how high)',
    )
    const pinned = { ...course, path: { ...course.path, anchor: { h: 27 } } } as typeof course
    const pinnedCanonical = JSON.parse(canonicalPlayerCourse(pinned)) as {
      path: { anchor: object }
    }
    expect(Object.keys(pinnedCanonical.path.anchor)).toEqual(['h'])
    const wet = { ...course, water: { level: 120 } } as typeof course
    const wetCanonical = JSON.parse(canonicalPlayerCourse(wet)) as { water: object }
    expect(Object.keys(wetCanonical.water)).toEqual(['level'])
    const lit = {
      ...course,
      light: { sunAzimuth: 10, sunElevation: 20, tint: [1, 0.5, 0.5], tintAmount: 0.3 },
    } as typeof course
    const litCanonical = JSON.parse(canonicalPlayerCourse(lit)) as { light: object }
    expect(Object.keys(litCanonical).sort()).toContain('light')
    expect(Object.keys(litCanonical.light).sort()).toEqual([
      'sunAzimuth',
      'sunElevation',
      'tint',
      'tintAmount',
    ])
    const withAuthor = validatePlayerCourse({ ...course, author: 'Swift Kestrel 42' })
    expect(withAuthor.ok).toBe(false)
    const errors = withAuthor.ok ? [] : withAuthor.errors
    expect(errors.some(([at, why]) => at.includes('author') && /not a field/.test(why))).toBe(true)
  })

  it('says an imported heightmap rides in the file and is kept here, and the file and library do exactly that (DEV-490)', async () => {
    expect(page()).toContain(
      'When a course stands on an island made from a heightmap you imported, the file carries that map too, and this browser keeps a copy of it with the course.',
    )
    // The map is 8x8 of 8-bit grey written as .r16's two bytes a sample: any
    // bytes the reader takes. The course names it by its SHA-256.
    const map = new Uint8Array(8 * 8 * 2).fill(40)
    const sha = await heightmapSha(map)
    const island = { map: sha, size: 4096, height: 400, sea: 0.05 }
    const onMap = { ...course, ground: island } as PlayerCourse
    const file = await readCourseFile(await courseFile(onMap, map))
    expect(file.ok && file.map && Array.from(file.map)).toEqual(Array.from(map))
    // A link cannot carry it.
    expect(courseLinkable(onMap)).toBe(false)
    await expect(courseLink(onMap, 'https://ff-10yr.pages.dev/')).rejects.toThrow()
    // And the library keeps it under its SHA, beside the course.
    const lib = createCourseLibrary(memoryBackend())
    expect(await lib.putMap(sha, map)).toBe(true)
    expect(Array.from((await lib.getMap(sha)) ?? [])).toEqual(Array.from(map))
    expect(COURSE_LIBRARY_DB.maps).toBe('maps')
  })

  it('says a lap on a player course is never sent to the lap server, and Share never offers one', () => {
    expect(page()).toContain("A lap on a player's course is never sent to the lap server")
    const lap = { seconds: 61.2, tainted: false, doc: { rules: LOCAL_LAP_RULES } }
    expect(shareable(lap)).toBe(false)
    expect(shareable({ ...lap, doc: { rules: 'anniversary.v1' } })).toBe(true)
  })

  it('names R2 among the hosts, since the game’s files come from there', () => {
    expect(page()).toContain('Pages, R2, D1 and Durable Objects')
  })
})

// DEV-479 (plan/FF-TV.md §2.4): Faceted Flight TV. The row that makes the list
// carries the text, and the premises sit beside it: the list holds no code, a
// TV viewer's names are Racer N, and a settled race leaves after the minutes
// the page says.
describe('DEV-479 — what /privacy says about Faceted Flight TV', () => {
  it('no longer says no list is published, and says a code is never listed', () => {
    const p = page()
    expect(p).not.toContain('No list of rooms is published')
    expect(p).toContain("A room's code is never listed anywhere.")
    expect(p).toContain(
      "While a room's race is on, it is shown on Faceted Flight TV without its code and without anyone's handle",
    )
    expect(p).toContain(
      "A room's watch link carries its code. Faceted Flight TV never does (below).",
    )
  })

  it('says TV shows no handle and no code, with the names removed on the server', async () => {
    const p = page()
    expect(p).toContain('<h2>Faceted Flight TV</h2>')
    expect(p).toContain(
      'Every race in a room is shown on Faceted Flight TV, about 2 seconds behind',
    )
    expect(p).toContain('racers appear as Racer 1, Racer 2 and so on')
    expect(p).toContain(
      'The names are removed on the server, before anything is sent to someone watching TV',
    )
    expect(p).toContain("TV never shows or sends a room's code, so nobody can join a room from TV")
    // The premise: what the broadcaster sends a TV viewer says Racer N, not the handle.

    const text = anonymiseText(
      JSON.stringify({ type: 'player-joined', slot: 0, player: { handle: 'Swift Kestrel 42' } }),
    )
    expect(text).toContain('"Racer 1"')
    expect(text).not.toContain('Kestrel')
  })

  it('describes the list, and when a room leaves it, from the guide’s constants', async () => {
    expect(PRIVACY_TV_RESULTS_MINUTES).toBe(TV_RESULTS_HOLD_MS / 60_000)
    expect(PRIVACY_TV_RESULTS_MINUTES).toBe(10)
    const p = page()
    expect(p).toContain(
      'a random TV number that is not its code, the course, what the race is doing',
    )
    expect(p).toContain('or 10 minutes after its results are in')
    expect(p).toContain('the server forgets the number when the room empties')
    // The premise: the list a viewer receives carries no room id.

    const guide = await TvGuide.load({
      now: () => 1000,
      storage: { get: async () => undefined, put: async () => {}, delete: async () => true },
      setAlarm: async () => {},
    })
    await guide.announce({
      tv: 'tv_abcdefghijklmnop',
      room: 'K7QX4M2',
      mission: 'int_01_hoverJet',
      phase: 'racing',
      racers: 3,
      goAt: 500,
      until: 100_000,
      at: 1000,
    })
    expect(JSON.stringify(guide.list())).not.toContain('K7QX4M2')
  })

  it('says what the exhibition sends, what a TV link carries, and what watching sends', () => {
    const p = page()
    expect(p).toContain(
      "When no room is racing, TV shows the game's own AI racers on one of its courses. Nothing is sent or kept for it.",
    )
    expect(p).toContain("A TV link names a race by its TV number, never by the room's code")
    expect(p).toContain('The link stops working when the room empties.')
    expect(p).toContain('A lap posted from the results panel can also be watched on TV') // DEV-571
    expect(p).toContain(
      'Watching TV sends only a request for the list, a request to watch and a periodic keep-alive. Nothing about who watches is kept.',
    )
    expect(p).toContain(
      'The developer can take one race off TV, or all of TV off the air for a time; each time is logged',
    )
  })
})

describe('DEV-571: what /privacy says the results panel asks', () => {
  it('says nothing is posted until a yes, and that saving a ghost sends nothing', () => {
    const p = page()
    expect(p).toContain(
      'After every lap the results panel asks whether to post it to the leaderboard, and the answer is no until you press yes.',
    )
    expect(p).toContain('The game sends a lap to the lap server only on that yes')
    expect(p).toContain('The results panel asks whether to save each lap as your ghost')
    expect(p).toContain('Saving a lap sends nothing.')
    expect(p).toContain('the link asks which')
    // The old button is gone, and the page no longer names it.
    expect(p).not.toContain('press Share')
  })
})

describe('DEV-588: the page names the visit counter and no longer says nothing leaves', () => {
  it('opens with what is true of everything below it, not with the old promise', () => {
    const p = page()
    expect(p).not.toContain('Nothing leaves your device unless you post a lap or join a room')
    expect(p).toContain('<h2>In short</h2>')
    expect(p).toContain('The site counts visits, never visitors')
    expect(p).toContain('A lap leaves your device only when you post it or race in a room.')
  })

  it('names the counter and the host its script loads from', () => {
    const p = page()
    expect(PRIVACY_VISIT_COUNTER).toBe('Cloudflare Web Analytics')
    expect(PRIVACY_VISIT_SCRIPT_HOST).toBe('static.cloudflareinsights.com')
    expect(p).toContain('<h2>Counting visits</h2>')
    expect(p).toContain(`The site uses ${PRIVACY_VISIT_COUNTER} to see how many people visit`)
    expect(p).toContain(`a small script from <code>${PRIVACY_VISIT_SCRIPT_HOST}</code>`)
    expect(p).toContain('It sets no cookie and keeps nothing in your browser.')
    expect(p).toContain(`Visits are counted by ${PRIVACY_VISIT_COUNTER}, and the game's own rows`)
  })

  // The premise of "the game sets no cookies", where code can hold it: nothing
  // the game or its Functions run reads or writes one. And the counter's script
  // is Cloudflare's injection at deploy, never a tag in this repository, which
  // is what the page says about where it comes from.
  it('the game and its Functions touch no cookie, and index.html loads no counter of its own', () => {
    const sweep = (dir: string): string[] =>
      walkTree(dir, { match: (name) => /\.(ts|tsx|js|mjs)$/.test(name) })
    const files = [
      ...sweep(path.join(process.cwd(), 'src')),
      ...sweep(path.join(process.cwd(), 'functions')),
    ]
    expect(files.length).toBeGreaterThan(100)
    const cookie = /document\.cookie|cookieStore|set-cookie/i
    expect(files.filter((f) => cookie.test(fs.readFileSync(f, 'utf8')))).toEqual([])
    const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
    expect(html).not.toContain('cloudflareinsights')
  })
})

describe('DEV-592: the page says what the game counts, lists every field it sends, and offers the off switch', () => {
  it('says what a row is, where it goes and for how long', () => {
    const p = page()
    expect(p).toContain('<h2>How the game is played</h2>')
    expect(p).toContain(
      `where ${PRIVACY_STATS_STORE} adds them up and keeps them for ${PRIVACY_STATS_KEEP_MONTHS} months`,
    )
    expect(p).toContain(
      "Rows share no key, so nothing ties one visit's rows to another visit, or to you.",
    )
    // Analytics Engine stamps each row's arrival, so rows sent together share a
    // moment: the page says so rather than claiming no two rows can be paired.
    expect(p).toContain('Cloudflare records when each row arrived')
    expect(p).not.toContain('no two rows can be linked')
    expect(p).toContain(`never a total of fewer than ${PRIVACY_STATS_SMALLEST} rows`)
    expect(p).toContain(`at most ${STATS_ERRORS_PER_VISIT} a visit`)
    expect(p).toContain('Nothing is sent while you play.')
  })

  it('lists every field of every kind the game sends, from the schema, and no kind it does not', () => {
    const list = statsFieldList()
    for (const kind of PRIVACY_STATS_KINDS) {
      for (const f of STATS_KINDS[kind])
        expect(list, `${kind}.${f.name}`).toContain(`<li>${f.name}: `)
    }
    expect(list).toContain('<li>country: ')
    expect(page()).toContain(list.replace(/\s+/g, ' '))
    // The kinds the game builds today are exactly the kinds the page lists.
    const built = new Set([
      new VisitTally().row({
        build: 'v0.18.0',
        channel: 'release',
        device: 'desktop',
        gate: 'ok',
        xrBlocker: 'none',
        quality: 'high',
        qualityAuto: true,
        scale: 1,
        look: 'anniversary',
        vignette: 'light',
        speedFx: 'full',
        horizon: false,
        now: 1,
      }).k,
    ])
    const errors = new ErrorTally()
    errors.note('error', 'x', 'none', { build: 'v0.18.0', channel: 'release', device: 'desktop' })
    for (const row of errors.take()) built.add(row.k)
    // DEV-593 and DEV-622: an attempt, its crash, and a bug report.
    const run = {
      mission: 'int_01_hoverJet',
      mode: 'ringAttack',
      look: 'anniversary',
      opponents: 'ai',
      variant: 'standard',
      ringsTaken: 3,
      ringsTotal: 21,
      crashes: 1,
      elapsed: 40,
    } as const
    const who = { build: 'v0.18.0', channel: 'release', device: 'desktop' } as const
    const attempt = new AttemptTally()
    attempt.start(1)
    const crash = attempt.crash('crash', { x: 1, y: 2, z: 3 }, run, who)
    if (crash) built.add(crash.k)
    const ended = attempt.end('quit', 'none', run, who)
    if (ended) built.add(ended.k)
    built.add(
      bugRow(
        { screen: 'mission', mission: 'int_01_hoverJet', tick: 100 },
        { ...who, quality: 'high', scale: 1, look: 'anniversary' },
        [],
      ).k,
    )
    expect([...built].sort()).toEqual([...PRIVACY_STATS_KINDS].sort())
  })

  it('says what an attempt, a crash and a bug report carry, and names the attempt counter (DEV-593, DEV-622)', () => {
    const p = page()
    expect(PRIVACY_BROWSER_STORES.statsAttempts).toBe(STATS_ATTEMPTS_KEY)
    expect(p).toContain(`<code>${STATS_ATTEMPTS_KEY}</code>, and only the range is sent.`)
    expect(p).toContain('a course you made yourself is sent only as "custom"')
    expect(p).toContain('These rows carry no time and no order')
    expect(p).toContain('A bug report, only when you press SEND on REPORT BUG')
    expect(p).toContain('Nothing you type and nothing about you.')
    expect(p).toContain('The one exception is a bug report, which you send to be read.')
    expect(p).toContain('or when you press SEND on REPORT BUG. Nothing is sent while you play.')
  })

  it('offers the off switch by the key the game reads, inlined, since a build ships no public/', () => {
    const p = privacyPage()
    expect(PRIVACY_BROWSER_STORES.statsOff).toBe(STATS_OPT_OUT_KEY)
    expect(p).toContain(`<code>${STATS_OPT_OUT_KEY}</code>`)
    expect(p).toContain('<button id="stats-off" type="button">')
    expect(p).toContain(`<script>${PRIVACY_STATS_SCRIPT_SOURCE}</script>`)
    expect(p.match(/<script/g)).toHaveLength(1)
    expect(PRIVACY_STATS_SCRIPT_SOURCE).toContain(`const key = '${STATS_OPT_OUT_KEY}'`)
    expect(PRIVACY_STATS_SCRIPT_SOURCE).toContain("getElementById('stats-off')")
    expect(PRIVACY_STATS_SCRIPT_SOURCE).toContain("getElementById('stats-state')")
    // It parses as a script, so the button is not dead on arrival.
    expect(() => new Function(PRIVACY_STATS_SCRIPT_SOURCE)).not.toThrow()
  })
})
