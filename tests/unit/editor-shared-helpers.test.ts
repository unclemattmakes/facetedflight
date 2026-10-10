// The helpers the desk and the bench used to carry a private copy of each
// (code-reuse BE-5): one rule, asserted once.

import { describe, expect, it } from 'vitest'
import type { WarningKind } from '@/editor/core'
import {
  type EditorDraft,
  GROUND_WARNING_KINDS,
  type History,
  NO_GROUND,
  randomInt,
  withAuthorLap,
} from '@/editor/core'

const draft = (tag: string, lap: EditorDraft['authorLap'] = null): EditorDraft =>
  ({ tag, authorLap: lap }) as unknown as EditorDraft

const historyOf = (past: EditorDraft[], present: EditorDraft, future: EditorDraft[]): History =>
  ({ past, present, future, openKey: null, saved: null, kind: {} }) as unknown as History

describe('withAuthorLap (DEV-468: an undo brings the flown lap back)', () => {
  it('is the identity for no lap', () => {
    const h = historyOf([draft('a')], draft('b'), [])
    expect(withAuthorLap(h, null)).toBe(h)
  })

  it('gives every snapshot the lap, past and future included', () => {
    const lap = { courseId: 'c1', seconds: 90 }
    const h = withAuthorLap(historyOf([draft('a')], draft('b'), [draft('c')]), lap)
    expect(h.past[0]?.authorLap).toBe(lap)
    expect(h.present.authorLap).toBe(lap)
    expect(h.future[0]?.authorLap).toBe(lap)
  })

  it('keeps a snapshot that already holds the same course with an equal or better time', () => {
    const held = draft('held', { courseId: 'c1', seconds: 80 })
    const other = draft('other', { courseId: 'c2', seconds: 10 })
    const h = withAuthorLap(historyOf([held], other, []), { courseId: 'c1', seconds: 90 })
    expect(h.past[0]).toBe(held)
    expect(h.present.authorLap).toEqual({ courseId: 'c1', seconds: 90 })
  })
})

describe('the ground vocabulary', () => {
  it('GROUND_WARNING_KINDS is the three kinds LIFT answers', () => {
    const want: WarningKind[] = ['ring-in-ground', 'line-under-ground', 'line-near-ground']
    expect([...GROUND_WARNING_KINDS].sort()).toEqual([...want].sort())
  })

  it('NO_GROUND puts nothing in the ground and nothing under it', () => {
    expect(NO_GROUND.surfaceAt(0, 0)).toBe(Number.NEGATIVE_INFINITY)
    expect(NO_GROUND.waterAt).toBeUndefined()
  })

  it('randomInt stays in [0, n)', () => {
    for (let i = 0; i < 200; i++) {
      const v = randomInt(7)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })
})
