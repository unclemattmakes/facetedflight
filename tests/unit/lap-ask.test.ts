// tests/unit/lap-ask.test.ts: the questions after a lap, as one menu. DEV-571.
//
// Matt, 2026-10-02: *"a.) always ask if they want to post to the leaderboard
// b.) ask if they want to save their ghost"*. These hold what the rows ARE,
// for every state the post and the save can be in: that the post question is
// asked of every lap that could go on a leaderboard and answered NO until its
// row is pressed; that the plate opens on home so A after a run still goes
// there (DEV-406); and that every word fits the plate it is drawn on.

import { describe, expect, it } from 'vitest'
import {
  LAP_ASK_GAP,
  LAP_ASK_NOTE_MAX,
  LAP_ASK_ROW,
  LAP_ASK_SCALE,
  LAP_ASK_YES_RANK,
  type LapAskFacts,
  lapAskAction,
  lapAskAimIndex,
  lapAskAsks,
  lapAskOpeningRow,
  lapAskOpeningRowFor,
  lapAskPlace,
  lapAskRows,
  lapAskScale,
  lapWouldRank,
  taintWords,
} from '@/game/lap-ask'
import {
  deleteFailed,
  pressShare,
  type ShareState,
  shareAsking,
  shareDeleted,
  shareFailed,
  sharePosted,
} from '@/game/lap-share'
import { appSourceThroughCtx } from './helpers/app-source'

const asking = shareAsking('Swift Kestrel 42')
const facts = (over: Partial<LapAskFacts> = {}): LapAskFacts => ({
  share: asking,
  boarded: true,
  postable: true,
  taint: [],
  kept: true,
  savedBefore: null,
  home: 'hangar',
  ...over,
})
const ids = (f: LapAskFacts) => lapAskRows(f).map((r) => r.id)
const row = (f: LapAskFacts, id: string) => lapAskRows(f).find((r) => r.id === id)

describe('which questions are asked', () => {
  it('a clean lap on a course with a leaderboard: post, another name, save, home', () => {
    expect(ids(facts())).toEqual([
      LAP_ASK_ROW.post,
      LAP_ASK_ROW.name,
      LAP_ASK_ROW.keep,
      LAP_ASK_ROW.home,
    ])
    expect(lapAskAsks(facts())).toBe(true)
  })

  it('the post is asked EVERY time, and answered NO until its row is pressed', () => {
    const post = row(facts(), LAP_ASK_ROW.post)
    expect(post?.label).toBe('Post to leaderboard?')
    expect(post?.value).toBe('No')
    expect(post?.note, 'the name it would go under, before any press').toBe(
      'press to post it as Swift Kestrel 42',
    )
  })

  it('a tainted lap is told why it cannot go on the leaderboard, and has no name to change', () => {
    const f = facts({ postable: false, taint: ['autopilot'] })
    expect(ids(f)).toEqual([LAP_ASK_ROW.post, LAP_ASK_ROW.keep, LAP_ASK_ROW.home])
    expect(row(f, LAP_ASK_ROW.post)).toMatchObject({
      label: 'Leaderboard',
      value: "Can't post",
      note: 'the autopilot flew part of this lap',
    })
  })

  it('a course with no leaderboard asks nothing about one', () => {
    expect(ids(facts({ boarded: false, postable: false }))).toEqual([
      LAP_ASK_ROW.keep,
      LAP_ASK_ROW.home,
    ])
  })

  it('a lap that cannot be saved here (no storage) is not asked about saving', () => {
    expect(ids(facts({ kept: null }))).toEqual([
      LAP_ASK_ROW.post,
      LAP_ASK_ROW.name,
      LAP_ASK_ROW.home,
    ])
  })

  it('with nothing to ask there is no menu: home alone is the plain panel', () => {
    const f = facts({ boarded: false, postable: false, kept: null })
    expect(ids(f)).toEqual([LAP_ASK_ROW.home])
    expect(lapAskAsks(f)).toBe(false)
  })

  it('after a playtest, home is the editor', () => {
    expect(row(facts({ home: 'editor' }), LAP_ASK_ROW.home)?.label).toBe('Back to the editor')
  })
})

describe('the save question', () => {
  it('says yes or no, and what each means against the ghost saved before', () => {
    expect(row(facts({ kept: true }), LAP_ASK_ROW.keep)).toMatchObject({
      label: 'Saved as your ghost',
      value: 'Yes',
      note: 'it flies with you next time on this course',
    })
    expect(row(facts({ kept: true, savedBefore: 61.24 }), LAP_ASK_ROW.keep)?.note).toBe(
      'replaces your 61.2 s; flies with you next',
    )
    expect(row(facts({ kept: false, savedBefore: 61.24 }), LAP_ASK_ROW.keep)).toMatchObject({
      value: 'No',
      note: 'keeps your saved 61.2 s ghost',
    })
    expect(row(facts({ kept: false }), LAP_ASK_ROW.keep)?.note).toBe(
      'no ghost is saved for this course',
    )
  })
})

describe('the post row through its states', () => {
  const posting: ShareState = { ...asking, phase: 'posting' }
  const posted = sharePosted(posting, {
    id: 'AbCdEf1234',
    link: 'h/?ghost=AbCdEf1234',
    board: true,
    rank: 4,
    boardReason: null,
  })
  const unranked = sharePosted(posting, {
    id: 'AbCdEf1234',
    link: 'h/?ghost=AbCdEf1234',
    board: false,
    rank: null,
    boardReason: '20 of 21 rings; ranked laps take all',
  })
  const states: [string, ShareState][] = [
    ['idle', asking],
    ['posting', posting],
    ['posted', posted],
    ['unranked', unranked],
    ['failed', shareFailed(asking, 'the hourly limit is reached; try again later')],
    ['confirm-delete', pressShare(posted, true).next],
    ['deleting', { ...posted, phase: 'deleting' }],
    ['deleted', shareDeleted(posted)],
    ['delete-failed', deleteFailed(posted, 'no such lap of yours')],
  ]

  it('names the place once posted, and offers to take it down', () => {
    expect(row(facts({ share: posted }), LAP_ASK_ROW.post)).toMatchObject({
      label: 'Posted',
      value: '#4',
      note: 'press to take it down',
    })
    expect(row(facts({ share: pressShare(posted, true).next }), LAP_ASK_ROW.post)).toMatchObject({
      label: 'Take it down?',
      value: 'Confirm',
    })
  })

  it('the name can change only before the post (or after a refusal)', () => {
    for (const [phase, share] of states) {
      const has = ids(facts({ share })).includes(LAP_ASK_ROW.name)
      expect(has, phase).toBe(phase === 'idle' || phase === 'failed')
    }
  })

  it('every row fits the plate: label and value on one line, the note under it', () => {
    // The pause plate's type (`render/pause.ts`): a label and its value share
    // ~25 characters of a row at 0.075 of the plate, a note ~44 at 0.045.
    const all: LapAskFacts[] = [
      ...states.map(([, share]) => facts({ share })),
      facts({ postable: false, taint: ['autopilot'] }),
      facts({ postable: false, taint: ['edition changed mid-lap'] }),
      facts({ postable: false, taint: ['props'] }),
      facts({ kept: false, savedBefore: 999.94 }),
      facts({ kept: true, savedBefore: 999.94 }),
      facts({ home: 'editor' }),
      facts({ share: shareAsking('Wwwwwwww Wwwwwwww 99') }),
    ]
    for (const f of all) {
      for (const r of lapAskRows(f)) {
        const line = `${r.label} ${r.value ?? ''}`.trim()
        expect(line.length, `${r.id}: ${line}`).toBeLessThanOrEqual(23)
        expect(r.note.length, `${r.id}: ${r.note}`).toBeLessThanOrEqual(LAP_ASK_NOTE_MAX)
      }
    }
  })

  it('no em-dash in any word a player reads (CLAUDE.md rule 11)', () => {
    const dash = String.fromCharCode(0x2014)
    for (const [, share] of states) {
      for (const r of lapAskRows(facts({ share }))) {
        expect(`${r.label}${r.value ?? ''}${r.note}`).not.toContain(dash)
      }
    }
  })
})

describe('the aim', () => {
  it('opens on home, so A after a run still goes home (DEV-406)', () => {
    const rows = lapAskRows(facts())
    expect(lapAskOpeningRow).toBe(LAP_ASK_ROW.home)
    expect(lapAskAimIndex(rows, lapAskOpeningRow)).toBe(rows.length - 1)
  })

  it('is held by row, so a row that leaves never moves it onto a neighbour', () => {
    const before = lapAskRows(facts())
    expect(lapAskAimIndex(before, LAP_ASK_ROW.keep)).toBe(2)
    const posted = sharePosted(
      { ...asking, phase: 'posting' },
      { id: 'x', link: 'h/?ghost=x', board: true, rank: 1, boardReason: null },
    )
    const after = lapAskRows(facts({ share: posted }))
    expect(after[lapAskAimIndex(after, LAP_ASK_ROW.keep)]?.id).toBe(LAP_ASK_ROW.keep)
    // ANOTHER NAME has gone: an aim on it falls back to home, not to SAVE.
    expect(after[lapAskAimIndex(after, LAP_ASK_ROW.name)]?.id).toBe(LAP_ASK_ROW.home)
  })

  it('a press on each row means one thing', () => {
    expect(lapAskAction(LAP_ASK_ROW.post)).toBe('post')
    expect(lapAskAction(LAP_ASK_ROW.name)).toBe('name')
    expect(lapAskAction(LAP_ASK_ROW.keep)).toBe('keep')
    expect(lapAskAction(LAP_ASK_ROW.home)).toBe('home')
    expect(lapAskAction(undefined)).toBe('none')
  })
})

describe('why a lap cannot be posted, in a stranger’s words', () => {
  it('names the autopilot, a look changed mid-lap, or the switch', () => {
    expect(taintWords(['autopilot', 'props'])).toBe('the autopilot flew part of this lap')
    expect(taintWords(['edition changed mid-lap'])).toBe('the look changed during the lap')
    expect(taintWords(['props'])).toBe('a test switch is on: ?props')
    expect(taintWords([])).toBe('it cannot be checked')
  })
})

describe('where the plate hangs', () => {
  // The results panel's and the pause plate's own measures, as `app.ts` hands them in.
  const panel = { y: 1.2, z: -0.95, width: 0.62, height: 0.34 }
  const plate = { width: 0.56, top: 0.21 }

  it('under the panel, centred, its top edge a gap below the panel’s bottom', () => {
    const at = lapAskPlace(panel, plate, false)
    expect(at.x).toBe(0)
    expect(at.z).toBe(panel.z)
    expect(at.y + plate.top * LAP_ASK_SCALE).toBeCloseTo(
      panel.y - panel.height / 2 - LAP_ASK_GAP,
      12,
    )
  })

  it('beside it on a touch screen: to the right, tops level, clear of the panel', () => {
    const at = lapAskPlace(panel, plate, true)
    const scale = lapAskScale(true)
    expect(at.y + plate.top * scale).toBeCloseTo(panel.y + panel.height / 2, 12)
    expect(at.x - (plate.width * scale) / 2).toBeCloseTo(panel.width / 2 + LAP_ASK_GAP, 12)
  })

  it('is one size up on a touch screen (DEV-794), and the same everywhere else', () => {
    expect(lapAskScale(false)).toBe(LAP_ASK_SCALE)
    expect(lapAskScale(true)).toBeGreaterThan(LAP_ASK_SCALE * 1.1)
    expect(lapAskScale(true)).toBeLessThan(LAP_ASK_SCALE * 1.4)
  })
})

describe('the wiring in app.ts', () => {
  // Source, because the wiring lives in the frame loop's closure, which no unit
  // test can build; `ghost-share.spec.ts` drives it on the player's route.
  // Read through the split's `ctx.` plumbing: the pause plate's aim moved to
  // `boot/app/hangar/menus.ts` (APP-SPLIT 4.6d).
  it('A after a run presses the aimed row, inside the run-over branch; home falls through home', () => {
    expect(appSourceThroughCtx()).toMatch(
      /\} else if \(lastResult\) \{[\s\S]{0,1200}?if \(lapAskUp\(\) && askConfirm\(\)\) \{/,
    )
  })

  it('posts only from the post row: the old two-press Share button is gone', () => {
    const app = appSourceThroughCtx()
    expect(app).not.toMatch(/pressShareLap|pressReroll/)
    // The one call that sends a lap, and the one press that reaches it.
    expect(app.match(/void postLap\(\)/g) ?? []).toHaveLength(1)
    expect(app).toMatch(/case 'post': \{\s*const pressed = pressShare\(share, shareOffered\(\)\)/)
  })

  it('every device reaches the plate: the stick, a finger or a cursor, and the laser', () => {
    const app = appSourceThroughCtx()
    expect(app).toMatch(/if \(lapAskUp\(\)\) \{\s*askNudge\(menuStepNow\(\)\)/)
    expect(app).toMatch(/taps:\s*titleMenuUp\(\) \|\|\s*lapAskUp\(\)/)
    expect(app).toMatch(/tvView\.plateUp\(\) \|\|\s*lapAskUp\(\)\)/)
    expect(app).toMatch(/setCursorTarget\(\(x, y\) => askRowAt\(x, y\) !== null, 'lap-ask'\)/)
  })
})

// ── DEV-629: a lap that would rank opens on POST ──────────────────────────
//
// Matt, 2026-10-04: *"make submit to leaderboards "yes" the default if they
// rank in the top 1000"*. Pinned: changing the threshold is an edit here.
describe('DEV-629: the default for a lap that would rank', () => {
  it('ranks by seconds, an equal time behind the lap already there', () => {
    expect(lapWouldRank(50, [], 100)).toBe(1)
    expect(lapWouldRank(50, [49, 51, 60], 100)).toBe(2)
    expect(lapWouldRank(50, [50], 100)).toBe(2)
    expect(lapWouldRank(70, [49, 51, 60], 100)).toBe(4)
  })

  it('is null behind a FULL board, and for a time that is not a number', () => {
    const full = Array.from({ length: 100 }, (_, i) => 40 + i)
    expect(lapWouldRank(200, full, 100)).toBeNull()
    expect(lapWouldRank(40.5, full, 100)).toBe(2)
    expect(lapWouldRank(Number.NaN, [], 100)).toBeNull()
  })

  it("Matt's number is 1000", () => {
    expect(LAP_ASK_YES_RANK).toBe(1000)
  })

  it('opens on POST where it would rank, and on home otherwise (DEV-406)', () => {
    expect(lapAskOpeningRowFor(facts({ wouldRank: 3 }))).toBe(LAP_ASK_ROW.post)
    expect(lapAskOpeningRowFor(facts({ wouldRank: null }))).toBe(LAP_ASK_ROW.home)
    expect(lapAskOpeningRowFor(facts())).toBe(LAP_ASK_ROW.home)
    expect(lapAskOpeningRowFor(facts({ wouldRank: LAP_ASK_YES_RANK + 1 }))).toBe(LAP_ASK_ROW.home)
    expect(lapAskOpeningRowFor(null)).toBe(LAP_ASK_ROW.home)
  })

  it('never for a lap that cannot be posted, or one already posted', () => {
    expect(lapAskOpeningRowFor(facts({ wouldRank: 1, postable: false }))).toBe(LAP_ASK_ROW.home)
    expect(lapAskOpeningRowFor(facts({ wouldRank: 1, boarded: false }))).toBe(LAP_ASK_ROW.home)
    const posted = sharePosted(
      { ...asking, phase: 'posting' },
      { id: 'AbCdEf1234', link: 'h/?ghost=AbCdEf1234', board: true, rank: 1, boardReason: null },
    )
    expect(lapAskOpeningRowFor(facts({ wouldRank: 1, share: posted }))).toBe(LAP_ASK_ROW.home)
  })

  it('still answers NO until pressed, and says where it would land', () => {
    const r = row(facts({ wouldRank: 7 }), LAP_ASK_ROW.post)
    expect(r?.value).toBe('No')
    expect(r?.note).toContain('#7')
    expect((r?.note ?? '').length).toBeLessThanOrEqual(LAP_ASK_NOTE_MAX)
  })
})
