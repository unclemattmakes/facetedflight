// DEV-889: the draft shelf, the player wording of the one-point refusal, the
// banner that no longer repeats a line, and the run-out fix.
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import {
  type DraftStorage,
  draftFromCourse,
  draftToDrop,
  EDITOR_POLICY,
  evaluateDraft,
  extendRunout,
  type Ground,
  isBlankDraft,
  listDrafts,
  newDraft,
  saveDraft,
  setFinish,
  shelfLabel,
  shelfOf,
} from '@/editor/core'
import { leaveAsks, shelfWords } from '@/editor/desk/leave'
import { refusalLead } from '@/editor/desk/panel'
import { fittedCourse, shippedLevels } from './helpers/editor-course'

const int01 = shippedLevels().find((l) => l.id === 'int_01_hoverJet') as Level
const COURSE = fittedCourse(int01)
const DRAFT = draftFromCourse(COURSE)
const ABYSS: Ground = { surfaceAt: () => -1e5 }

const memory = (): DraftStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('DEV-889: the shelf', () => {
  it('holds the last five, newest first, and says which one the next would push off', () => {
    const s = memory()
    for (let i = 0; i < 4; i++) saveDraft(s, `s${i}`, DRAFT, 1000 + i)
    expect(draftToDrop(s)).toBeNull()
    saveDraft(s, 's4', DRAFT, 1004)
    expect(listDrafts(s).map((d) => d.slot)).toEqual(['s4', 's3', 's2', 's1', 's0'])
    expect(EDITOR_POLICY.maxDrafts).toBe(5)
    // Full: the next one pushes off the least recently saved.
    expect(draftToDrop(s)?.slot).toBe('s0')
    saveDraft(s, 's5', DRAFT, 1005)
    expect(listDrafts(s).map((d) => d.slot)).toEqual(['s5', 's4', 's3', 's2', 's1'])
  })

  it('lists the other drafts without the one being edited', () => {
    const s = memory()
    saveDraft(s, 'a', DRAFT, 1)
    saveDraft(s, 'b', DRAFT, 2)
    expect(shelfOf(s, 'b').map((d) => d.slot)).toEqual(['a'])
  })

  it('names a draft by course, island and time (the date only when not today)', () => {
    const s = memory()
    const at = new Date(2026, 9, 9, 14, 32).getTime()
    saveDraft(s, 'a', DRAFT, at)
    const d = listDrafts(s)[0]
    if (!d) throw new Error('no draft')
    const today = shelfLabel(d, new Date(2026, 9, 9, 18, 0).getTime())
    expect(today).toBe(
      `${DRAFT.course.name[0]} ${DRAFT.course.name[1]} · ${DRAFT.course.island} · 14:32`,
    )
    const later = shelfLabel(d, new Date(2026, 9, 11, 9, 0).getTime())
    expect(later.endsWith('· Oct 9, 14:32')).toBe(true)
  })

  it('a draft with no line and no props is blank; one with a line is not', () => {
    expect(isBlankDraft(newDraft(int01, ['Deft', 'Rocket']))).toBe(true)
    expect(isBlankDraft(DRAFT)).toBe(false)
  })

  it('the question names the draft it would drop and the size of the shelf', () => {
    const w = shelfWords('Deft Rocket · alpine · 14:32', 5)
    expect(w.body).toContain('Deft Rocket · alpine · 14:32')
    expect(w.body).toContain('5 drafts')
    expect(leaveAsks(true)).toBe(false)
  })
})

describe('DEV-889: the player wording', () => {
  it('a one-point course says what to do, not the validator’s path', () => {
    const one = {
      ...DRAFT,
      course: {
        ...DRAFT.course,
        path: {
          ...DRAFT.course.path,
          points: [DRAFT.course.path.points[0] as [number, number, number]],
        },
      },
    }
    const e = evaluateDraft(one, int01, ABYSS)
    const msgs = e.warnings.filter((w) => w.kind === 'invalid').map((w) => w.message)
    expect(msgs.some((m) => m.includes('Add a second point'))).toBe(true)
    expect(msgs.some((m) => m.includes('path.points'))).toBe(false)
  })

  it('the banner does not repeat the first problem', () => {
    expect(refusalLead([])).toBe('')
    const one = refusalLead(['Ring 1: the ground reaches 4 m into its opening'])
    expect(one).not.toContain('Ring 1')
    expect(refusalLead(['a', 'b'])).toContain('2 red problems')
  })
})

describe('DEV-889: Extend run-out', () => {
  const atEnd = setFinish(DRAFT, 1)
  const runoff = (d: typeof DRAFT) =>
    evaluateDraft(d, int01, ABYSS).warnings.filter((w) => w.kind === 'finish-no-runoff')

  it('premise: a finish at the line’s end says there is no run-out', () => {
    expect(runoff(atEnd).length).toBe(1)
  })

  it('adds one point past the end, keeps the finish where it was, and clears the note', () => {
    const out = extendRunout(atEnd, int01, ABYSS)
    expect(out).not.toBe(atEnd)
    expect(out.course.path.points.length).toBe(atEnd.course.path.points.length + 1)
    expect(out.course.path.points.slice(0, -1)).toEqual(atEnd.course.path.points)
    expect(runoff(out)).toEqual([])
    // Nothing else new: no errors the extension caused.
    expect(evaluateDraft(out, int01, ABYSS).warnings.filter((w) => w.severity === 'error')).toEqual(
      evaluateDraft(atEnd, int01, ABYSS).warnings.filter((w) => w.severity === 'error'),
    )
  })

  it('is a no-op (the same draft) when the run-out is long enough', () => {
    expect(extendRunout(DRAFT, int01, ABYSS)).toBe(DRAFT)
  })
})
