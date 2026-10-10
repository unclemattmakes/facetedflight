// tests/unit/mission-index.test.ts — the level select is DATA, or it is a bug.
//
// CLAUDE.md hard rule 6: *"Adding a mission, an environment or a vehicle must
// never require touching `src/`. If it does, that is an architecture bug, not a
// task."* A picker is the single easiest place in this codebase to break that —
// thirteen ids in an array is the obvious way to write one, it works, and it
// keeps working right up until somebody adds a mission and it silently does not
// appear.
//
// `boot/app.ts` has already shipped exactly this failure once. It asked for
// `'simonet.islands'` as a string literal and never read `level.environment`,
// so nine of the thirteen missions loaded, reported `data-terrain-ready` and
// rendered the WRONG WORLD without erroring (`load-terrain.ts`'s own header).
// *Almost right is the most expensive kind of wrong.*
//
// So this file tests the property rather than the output: not "there are
// thirteen cards" (a hard-coded list passes that too) but **the cards come from
// the directory**, and **no mission id appears in the source at all**.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FLEET_2016, fleetOf } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { authoredLevelIds, generatedLevelIds, levelIds } from '@/content/load-level'
import {
  bestLine,
  cardFor,
  fixedPages,
  humanise,
  loadMissionIndex,
  type MissionCard,
  slotOrder,
} from '@/game/mission-index'
import { REPO as ROOT } from './helpers/repo-root'

const ANNIVERSARY = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'content', 'editions', 'anniversary.json'), 'utf8'),
) as Edition

/** Enough of a level to make a card. Everything else is somebody else's test. */
const level = (over: Partial<Level>): Level =>
  ({
    id: 'x',
    title: 'X',
    vehicle: 'hoverjet',
    difficulty: 'beginner',
    chainIndex: null,
    environment: 'simonet',
    mode: 'ringAttack',
    forcedMode: null,
    ...over,
  }) as Level

/** No DOM in this suite, so `readBest` is handed an explicit empty store. */
const NO_STORAGE = null
const card = (over: Partial<Level>): MissionCard => cardFor(level(over), NO_STORAGE)

describe('the mission index comes from the content directory', () => {
  it('has exactly one card per level JSON on disk', async () => {
    // Counted two ways: through `import.meta.glob` (what the game does) and
    // through `readdir` (what a person does when they add a mission). A picker
    // with a list in it passes the first and fails the second the moment they
    // disagree — which is the whole point of running both.
    //
    // Since DEV-375 the directory is TWO: every generated level, and every
    // authored one whose file opts in with `"listed": true`.
    const jsonIn = (dir: string): string[] =>
      fs
        .readdirSync(path.join(ROOT, 'content', dir))
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    //
    // And since DEV-399 the authored ones are filtered by the edition's FLEET:
    // a course in an aircraft the edition does not fly is not a card. Counted
    // for both fleets the game has — 2016's (the default, Classic's) and
    // Anniversary's, which flies the glider.
    const authored = jsonIn('authored').map(
      (f) =>
        [
          f,
          JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'authored', f), 'utf8')) as {
            listed?: unknown
            vehicle?: string
          },
        ] as const,
    )
    for (const [fleet, flies] of [
      [FLEET_2016, (v: string) => v !== 'glider'],
      [fleetOf(() => ANNIVERSARY), (_v: string) => true],
    ] as const) {
      const listedAuthored = authored
        .filter(([, l]) => l.listed === true && flies(l.vehicle ?? ''))
        .map(([f]) => f)
      const onDisk = [...jsonIn('levels'), ...listedAuthored]
      const cards = await loadMissionIndex(undefined, fleet)
      expect(cards).toHaveLength(onDisk.length)
      expect(cards).toHaveLength((await levelIds(fleet)).length)
      expect(cards.map((c) => c.id).sort()).toEqual(
        onDisk.map((f) => f.replace(/\.json$/, '')).sort(),
      )
    }
  })

  it('mentions NO mission id anywhere in the level select source', () => {
    // The mechanical form of "a fourteenth JSON costs no code change". If any
    // of these files names a mission, the index is not reading the directory —
    // it is agreeing with it, which is a different thing and drifts.
    //
    // Comments are stripped first, the same way `sim-purity-guard.test.ts`
    // does: prose that *names* a mission while explaining a decision is not a
    // dependency on it.
    const files = [
      'src/game/mission-index.ts',
      'src/game/mission-shape.ts',
      'src/render/hangar.ts',
      'src/render/diorama.ts',
      'src/render/mode-mark.ts',
    ]
    // Every id in either tree, listed or not: a source that named an unlisted
    // authored course would be reaching for it past the menu's own rule.
    const ids = [...generatedLevelIds(), ...authoredLevelIds()]
    expect(ids.length).toBeGreaterThan(0)
    const offences: string[] = []
    for (const rel of files) {
      const src = fs
        .readFileSync(path.join(ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      for (const id of ids) if (src.includes(id)) offences.push(`${rel} names "${id}"`)
    }
    expect(offences).toEqual([])
  })

  it('reads the mode that will actually RUN, not the one that was authored', () => {
    // `forcedMode` was in the schema and read by nothing for weeks. Two shipped
    // scenes carry it — both to Free Flight — and a menu that prints
    // `level.mode` tells you the opposite of what you are about to play.
    expect(card({ mode: 'ringAttack', forcedMode: 'freeFlight' }).mode).toBe('freeFlight')
    expect(card({ mode: 'ringAttack', forcedMode: 'freeFlight' }).modeName).toBe('Free Flight')
    expect(card({ mode: 'ringAttack', forcedMode: null }).modeName).toBe('Ring Attack')
  })

  it('never hides a mission behind an unknown key', () => {
    // The display table is a decoration, not a gate. A fourteenth mission in a
    // fifth environment, on a third vehicle, in a fourth mode, must still
    // produce a legible card — a slightly plainer label is a cosmetic debt, an
    // absent table is a content bug.
    const exotic = card({
      environment: 'sky_city',
      vehicle: 'orbiter' as Level['vehicle'],
      mode: 'gauntlet' as Level['mode'],
    })
    expect(exotic.environmentName).toBe('Sky City')
    expect(exotic.vehicleName).toBe('Orbiter')
    expect(exotic.modeName).toBe('Gauntlet')
    for (const s of [exotic.environmentName, exotic.vehicleName, exotic.modeName]) {
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('humanises machine keys the way a label needs', () => {
    expect(humanise('ringAttack')).toBe('Ring Attack')
    expect(humanise('target_practice')).toBe('Target Practice')
    expect(humanise('kauai')).toBe('Kauai')
    expect(humanise('')).toBe('')
  })

  it('words a best the same way everywhere, or it words an invitation', () => {
    expect(bestLine(null)).toBe('no time set')
    expect(bestLine({ score: 2100, timeSeconds: 57.3211, gates: 21, setAt: 0 })).toBe(
      'best 2100 · 57.3s',
    )
  })
})

/* ══════════════════════════════ THE FIXED SLOTS ═══════════════════════════ */

/**
 * DEV-203's machinery, at the content layer.
 *
 * Matt, 2026-09-17: *"aircraft > mode > difficulty > location (these should be
 * fixed, not randomly placed as they are now)."* They were not random; a
 * table's bearing was a function of the SLOT INDEX and the PAGE SIZE, and then
 * the page was rotated so whatever you had arrived in sat under the pointer. So
 * the same option moved whenever the page's contents or the loaded mission did.
 *
 * What replaces it is `slotOrder` (which key goes where) and `fixedPages` (put
 * it there). The geometry that turns a slot into a bearing is
 * `tests/unit/level-select.test.ts`; the four steps built on top are
 * `tests/unit/level-steps.test.ts`. This file owns the two pure functions.
 */
describe('the slot ORDER is read off the content', () => {
  it('reproduces the two orders this port already writes down by hand', async () => {
    // The check worth having, and the kind CLAUDE.md asks for: `VEHICLE_ORDER`
    // and `DIFFICULTY_ORDER` were transcribed from 2016's `page_shipSelection`
    // and `page_rankSelection`, and `chainIndex` is `Button_Next.cs` — a
    // DIFFERENT 2016 file. Two independent sources agreeing is evidence; a
    // derivation checked against itself is not.
    const cards = await loadMissionIndex()
    expect(slotOrder(cards, (c) => c.vehicle)).toEqual(['hoverjet', 'jumpseat'])
    expect(slotOrder(cards, (c) => c.difficulty)).toEqual([
      'beginner',
      'intermediate',
      'professional',
    ])
  })

  it('orders the shipped modes and places, campaign-chain first', async () => {
    const cards = await loadMissionIndex()
    // `energyRace` has no shipped level (DEV-143), so it is not a slot: a mode
    // table with nothing behind it is worse than no table. The teaching mode
    // IS one since DEV-379 listed the two canyon lessons: outside 2016's chain,
    // so after every chained key, and after Free Flight by key.
    expect(slotOrder(cards, (c) => c.mode)).toEqual([
      'ringAttack',
      'targetPractice',
      'freeFlight',
      'lesson',
    ])
    // Four places, four slots — exactly the arc.
    expect(slotOrder(cards, (c) => c.environment)).toEqual(['alpine', 'desert', 'simonet', 'kauai'])
  })

  it('does not depend on the order the cards arrive in', () => {
    // A menu that reshuffles between loads is a menu you cannot learn, and
    // `loadMissionIndex` settles thirteen parallel fetches.
    const cards = [
      card({ id: 'c', environment: 'z', chainIndex: 2 }),
      card({ id: 'a', environment: 'x', chainIndex: 0 }),
      card({ id: 'b', environment: 'y', chainIndex: 1 }),
    ]
    const want = ['x', 'y', 'z']
    expect(slotOrder(cards, (c) => c.environment)).toEqual(want)
    expect(slotOrder([...cards].reverse(), (c) => c.environment)).toEqual(want)
  })

  it('puts a key OUTSIDE the chain after every key inside it, by key', () => {
    // Free Flight is the live case: `hoverJet_kauai_beg` has `chainIndex: null`.
    // Two unchained keys tie on Infinity, which is why the comparator compares
    // rather than subtracts — `Infinity - Infinity` is NaN and a NaN comparator
    // leaves the sort implementation-defined.
    const cards = [
      card({ id: 'n2', environment: 'zulu', chainIndex: null }),
      card({ id: 'n1', environment: 'alfa', chainIndex: null }),
      card({ id: 'c', environment: 'mike', chainIndex: 5 }),
    ]
    expect(slotOrder(cards, (c) => c.environment)).toEqual(['mike', 'alfa', 'zulu'])
  })

  it('takes a key EARLIEST appearance, not its last', () => {
    // Alpine is chain 0, 3 and 6. If the rule took the last it would sort after
    // the desert, and the arc a player learned would change the day a course
    // was added at the end of the chain.
    const cards = [
      card({ id: 'a', environment: 'alpine', chainIndex: 6 }),
      card({ id: 'b', environment: 'desert', chainIndex: 1 }),
      card({ id: 'c', environment: 'alpine', chainIndex: 0 }),
    ]
    expect(slotOrder(cards, (c) => c.environment)).toEqual(['alpine', 'desert'])
  })
})

describe('a fixed slot belongs to the KEY, not to the page', () => {
  const ORDER = ['alpine', 'desert', 'simonet', 'kauai']
  const at = (items: { env: string }[]) =>
    fixedPages(items, (i) => i.env, ORDER, 4)[0]?.map((i) => i?.env ?? null)

  it('leaves the SAME key in the same position however many others are present', () => {
    // THE assertion. Under the old layout `tableBearings(count)` moved every
    // option when the count changed: Beginner sat at -45 on a three-rank page
    // and at -15 on a one-rank page. Here Simonet is slot 2 in all four cases.
    expect(
      at([{ env: 'alpine' }, { env: 'desert' }, { env: 'simonet' }, { env: 'kauai' }]),
    ).toEqual(['alpine', 'desert', 'simonet', 'kauai'])
    expect(at([{ env: 'desert' }, { env: 'simonet' }])).toEqual([null, 'desert', 'simonet', null])
    expect(at([{ env: 'simonet' }])).toEqual([null, null, 'simonet', null])
    expect(at([{ env: 'kauai' }, { env: 'simonet' }])).toEqual([null, null, 'simonet', 'kauai'])
  })

  it('does not close a gap — an empty position stays empty', () => {
    // Free Flight × Intermediate holds no course today and is not an error; it
    // is content the sequel will add. Sliding Professional left to fill it is
    // exactly the "randomly placed" complaint in miniature.
    expect(at([{ env: 'alpine' }, { env: 'kauai' }])).toEqual(['alpine', null, null, 'kauai'])
  })

  it('always deals the ORDER a page, whether or not anything is on it', () => {
    // The page COUNT is a property of the order, so the lap plates do not
    // appear and vanish as content is filtered.
    expect(fixedPages([], (i: { env: string }) => i.env, ORDER, 4)).toHaveLength(1)
    expect(fixedPages([], (i: { env: string }) => i.env, ORDER, 4)[0]).toEqual([
      null,
      null,
      null,
      null,
    ])
    // Five keys need two pages even with nothing to put on them.
    expect(fixedPages([], (i: { env: string }) => i.env, [...ORDER, 'e5'], 4)).toHaveLength(2)
  })

  it('gives a FIFTH place its own fixed position on a second page', () => {
    // Hard rule 6's growth path: a fourteenth JSON in a fifth environment
    // appears, at its own position, with no code change.
    const order = [...ORDER, 'sky_city']
    const pages = fixedPages([{ env: 'sky_city' }, { env: 'alpine' }], (i) => i.env, order, 4)
    expect(pages).toHaveLength(2)
    expect(pages[0]?.map((i) => i?.env ?? null)).toEqual(['alpine', null, null, null])
    expect(pages[1]?.map((i) => i?.env ?? null)).toEqual(['sky_city', null, null, null])
  })

  it('SPILLS a repeated key rather than hiding it', () => {
    // *A display table must never be able to hide a mission.* No shipped cell
    // holds two courses in one environment; a fourteenth JSON could, and the
    // second one must still be reachable.
    const pages = fixedPages(
      [
        { env: 'desert', id: 1 },
        { env: 'desert', id: 2 },
      ],
      (i) => i.env,
      ORDER,
      4,
    )
    expect(pages).toHaveLength(2)
    expect(pages[0]?.[1]?.id).toBe(1)
    expect(pages[1]?.[1]?.id).toBe(2)
    // Same position on both pages, which is what makes it "the desert table".
    expect(pages[1]?.map((i) => i?.id ?? null)).toEqual([null, 2, null, null])
  })

  it('gives a key the order has never seen a table anyway', () => {
    // The display-name rule, one level up: an unknown key is placed plainly
    // rather than dropped. Absent from the menu is a content bug; a plainer
    // position is a cosmetic one.
    const pages = fixedPages([{ env: 'atlantis' }], (i) => i.env, ORDER, 4)
    expect(pages[0]?.map((i) => i?.env ?? null)).toEqual(['atlantis', null, null, null])
  })

  it('never drops an item, for any mixture of keys', () => {
    // The property, rather than a case. Every item put in comes out exactly
    // once, whatever the keys and however they collide.
    const items = [
      { env: 'desert', id: 0 },
      { env: 'desert', id: 1 },
      { env: 'desert', id: 2 },
      { env: 'alpine', id: 3 },
      { env: 'atlantis', id: 4 },
      { env: 'kauai', id: 5 },
    ]
    const out = fixedPages(items, (i) => i.env, ORDER, 4)
      .flat()
      .filter((i) => i !== null)
      .map((i) => i.id)
    expect(out.slice().sort()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('is total on the degenerate inputs', () => {
    // An empty order still has one page, so `pages.length === 0` keeps meaning
    // "the index has not landed" and nothing reads a blank arc as a page turn.
    expect(fixedPages([], (i: { env: string }) => i.env, [], 4)).toHaveLength(1)
    expect(fixedPages([{ env: 'a' }], (i) => i.env, [], 0)[0]).toEqual([{ env: 'a' }])
  })
})
