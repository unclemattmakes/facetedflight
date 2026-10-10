// tests/unit/editor-shipped.test.ts — the editor's shipped-mission draft.
// DEV-540 (plan/SHIPPED-COURSE-EDITS.md §4.2).
//
// The draft is 2016's level plus an override, and the level it draws and flies
// is the LOADER's `applyOverride` of it. So these hold the commands to what
// the loader and the writer will do with their result: every override a
// command writes validates, applies, and is already the canonical text the
// dev server writes; an edit undone is clean; a move put back leaves no file.
// Geometry is tested as geometry (the orientation lesson): a moved ring keeps
// its trigger's distance, and the racing-line warning is measured to the
// line's SEGMENTS (DEV-027), against every HoverJet mission 2016 shipped.
//
// No file is written. Every override here is built in memory.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOverride,
  canonicalOverrideText,
  manifestShaOf,
  OVERRIDE_SHAPE,
  ringKey,
  validateOverride,
} from '@/content/level-override'
import { type Level, liveRings, type Ring } from '@/content/level-schema'
import { generatedLevelIds, loadBaselineLevel } from '@/content/load-level'
import { PLAYER_COURSE_LIMITS } from '@/content/player-course'
import {
  addNote,
  addRingAfter,
  canRedo,
  canUndo,
  createHistory,
  distanceToLine,
  entityPose,
  entityState,
  evaluateShipped,
  isDirty,
  isShippedEditable,
  loadShippedDraft,
  markSaved,
  moveEntity,
  openShipped,
  overrideText,
  record,
  redo,
  removeEntity,
  revertEntity,
  SHIPPED_DRAFT_KIND,
  type ShippedDraft,
  type ShippedEntity,
  saveShippedDraft,
  selectEntity,
  setTimer,
  shippedDraftKey,
  shippedLevel,
  undo,
} from '@/editor/core'
import { REPO as ROOT } from './helpers/repo-root'

const MANIFEST = fs.readFileSync(path.join(ROOT, 'content', '_generated.sha256'), 'utf8')
const ID = 'int_01_hoverJet'
/** The furthest a pose on the format's 10 cm grid stands from where it was asked for: half a step on each axis. */
const ON_GRID = (OVERRIDE_SHAPE.posQuantumMetres / 2) * Math.sqrt(3) + 1e-9

const sha = (id: string): string => {
  const s = manifestShaOf(MANIFEST, id)
  if (!s) throw new Error(`no manifest line for ${id}`)
  return s
}

const open = async (id = ID): Promise<ShippedDraft> =>
  openShipped(await loadBaselineLevel(id), sha(id), null, null).draft

const ring = (level: Level, i: number): Ring => liveRings(level)[i] as Ring
const keyOf = (level: Level, i: number): string => ringKey(ring(level, i)) as string
const ringE = (key: string): ShippedEntity => ({ kind: 'ring', key })

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

/** The override text the draft holds validates, is canonical, and applies to its baseline. */
const expectWritable = (d: ShippedDraft): void => {
  const text = overrideText(d.override)
  if (text === null) return
  const checked = validateOverride(JSON.parse(text))
  expect(checked.ok, 'what the draft would save validates').toBe(true)
  if (!checked.ok) return
  expect(canonicalOverrideText(checked.override), 'and is already the canonical text').toBe(text)
  expect(() => applyOverride(d.base, JSON.parse(text)), 'and applies to its baseline').not.toThrow()
}

describe('DEV-540: opening a shipped mission', () => {
  it('the door opens the seven HoverJet missions and none of the six JumpSeat ones', async () => {
    const ids = generatedLevelIds()
    const open = []
    for (const id of ids) {
      if (isShippedEditable(await loadBaselineLevel(id))) open.push(id)
    }
    const hoverjets = []
    for (const id of ids)
      if ((await loadBaselineLevel(id)).vehicle === 'hoverjet') hoverjets.push(id)
    expect(open).toEqual(hoverjets)
    expect(open.length).toBeGreaterThan(0)
    expect(open.length).toBeLessThan(ids.length)
  })

  it('with no file and no stored draft: an empty override pinned to the manifest, clean, level = 2016', async () => {
    const base = await loadBaselineLevel(ID)
    const o = openShipped(base, sha(ID), null, null)
    expect(o.problems).toEqual([])
    expect(o.restored).toBe(false)
    expect(o.draft.override.base).toBe(sha(ID))
    expect(overrideText(o.draft.override), 'nothing to save').toBeNull()
    const h = createHistory(o.draft, SHIPPED_DRAFT_KIND)
    expect(isDirty(h)).toBe(false)
    const level = shippedLevel(o.draft)
    expect(liveRings(level).map((r) => r.pos)).toEqual(liveRings(base).map((r) => r.pos))
    expect(level.courseKey, 'no course segment for 2016 itself').toBeUndefined()
  })

  it('a stored draft made over the file on disk is restored; one made over another file is not', async () => {
    const base = await loadBaselineLevel(ID)
    const d0 = openShipped(base, sha(ID), null, null).draft
    const edited = moveEntity(d0, ringE(keyOf(base, 2)), [0, 300, 0], ring(base, 2).quat)
    const disk = overrideText(edited.override)
    const further = setTimer(edited, 'timeLimit', 170)
    // Stored over the same file: the unsaved edit comes back.
    const same = openShipped(base, sha(ID), disk, { from: disk, override: further.override })
    expect(same.restored).toBe(true)
    expect(same.draft.override.timer?.timeLimit).toBe(170)
    expect(same.saved).toBe(disk)
    // The file changed under it (a checkout, a hand edit): the file wins.
    const moved = openShipped(base, sha(ID), disk, { from: null, override: further.override })
    expect(moved.restored).toBe(false)
    expect(moved.draft.override.timer).toBeUndefined()
    expect(overrideText(moved.draft.override)).toBe(disk)
  })

  it('a stale base is re-pinned and said; an unreadable file is said and not opened', async () => {
    const base = await loadBaselineLevel(ID)
    const d0 = openShipped(base, sha(ID), null, null).draft
    const edited = moveEntity(d0, ringE(keyOf(base, 2)), [0, 300, 0], ring(base, 2).quat)
    const stale = (overrideText({ ...edited.override, base: '0'.repeat(64) }) as string).trim()
    const o = openShipped(base, sha(ID), stale, null)
    expect(o.draft.override.base).toBe(sha(ID))
    expect(o.problems.join(' ')).toMatch(/baseline moved/)
    const h = createHistory(o.draft, SHIPPED_DRAFT_KIND)
    expect(
      { ...h, saved: o.saved }.saved === SHIPPED_DRAFT_KIND.saved(o.draft),
      'dirty until re-saved',
    ).toBe(false)

    const bad = openShipped(base, sha(ID), '{"v":1,"mission":"int_01_hoverJet","fog":1}', null)
    expect(bad.problems.join(' ')).toMatch(/refused/)
    expect(overrideText(bad.draft.override)).toBeNull()
    const notJson = openShipped(base, sha(ID), 'not json', null)
    expect(notJson.problems.join(' ')).toMatch(/not JSON/)
  })

  it('the draft is kept in this browser under its own key, and read back', async () => {
    const d0 = await open()
    const d = setTimer(d0, 'timeLimit', 170)
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    saveShippedDraft(storage, d, 'text on disk')
    expect([...store.keys()]).toEqual([shippedDraftKey(ID)])
    expect(shippedDraftKey(ID)).toBe('ff2.editor.shipped.v1.int_01_hoverJet')
    const back = loadShippedDraft(storage, ID)
    expect(back?.from).toBe('text on disk')
    expect(back?.override).toEqual(d.override)
    expect(loadShippedDraft(storage, 'rookie_01_hoverJet')).toBeNull()
    store.set(shippedDraftKey(ID), '{')
    expect(loadShippedDraft(storage, ID)).toBeNull()
  })
})

describe('DEV-540: the commands', () => {
  it('a ring moved is moved rigidly: its trigger keeps its distance, and the file names it by fileID', async () => {
    const d0 = await open()
    const r = ring(d0.base, 4)
    const key = keyOf(d0.base, 4)
    const to = [r.pos[0] + 30, r.pos[1] - 12, r.pos[2] + 7]
    const d = moveEntity(d0, ringE(key), to, r.quat)
    expect(d).not.toBe(d0)
    expect(Object.keys(d.override.rings?.move ?? {})).toEqual([key])
    const moved = ring(shippedLevel(d), 4)
    expect(dist(moved.pos, to)).toBeLessThan(ON_GRID)
    expect(dist(moved.trigger.pos, moved.pos)).toBeCloseTo(dist(r.trigger.pos, r.pos), 3)
    expect(entityState(d, ringE(key))).toBe('moved')
    expectWritable(d)
  })

  it('put back on 2016’s pose, a move drops out of the file; moving to where it is is a no-op', async () => {
    const d0 = await open()
    const r = ring(d0.base, 4)
    const e = ringE(keyOf(d0.base, 4))
    expect(moveEntity(d0, e, r.pos, r.quat), 'no move of nothing').toBe(d0)
    const d = moveEntity(d0, e, [r.pos[0] + 40, r.pos[1], r.pos[2]], r.quat)
    expect(moveEntity(d, e, [r.pos[0] + 40, r.pos[1], r.pos[2]], r.quat)).toBe(d)
    const back = moveEntity(d, e, r.pos, r.quat)
    expect(back.override.rings).toBeUndefined()
    expect(overrideText(back.override)).toBeNull()
  })

  it('a turn indicator and the finish move; the finish cannot be removed', async () => {
    const d0 = await open()
    const [t] = d0.base.turnIndicators.filter((x) => x.live)
    if (!t) throw new Error('no turn indicator')
    const tKey = (t as { _meta?: { fileID?: string } })._meta?.fileID as string
    const e: ShippedEntity = { kind: 'turn', key: tKey }
    const d1 = moveEntity(d0, e, [t.pos[0] + 20, t.pos[1], t.pos[2]], t.quat)
    expect(Object.keys(d1.override.turnIndicators?.move ?? {})).toEqual([tKey])
    const f = d0.base.finish
    if (!f) throw new Error('no finish')
    const fin: ShippedEntity = { kind: 'finish' }
    const d2 = moveEntity(d1, fin, [f.pos[0], f.pos[1] + 5, f.pos[2]], f.quat)
    const level = shippedLevel(d2)
    expect(dist(level.finish?.pos ?? [], [f.pos[0], f.pos[1] + 5, f.pos[2]])).toBeLessThan(ON_GRID)
    expect(entityPose(level, e)?.pos[0]).toBeCloseTo(t.pos[0] + 20, 1)
    expect(removeEntity(d2, fin)).toBe(d2)
    expectWritable(d2)
  })

  it('remove and add: counts move by one, an add stands between its neighbours, and removing it re-anchors', async () => {
    const d0 = await open()
    const n = liveRings(d0.base).length
    const k5 = keyOf(d0.base, 5)
    const removed = removeEntity(d0, ringE(k5))
    expect(liveRings(shippedLevel(removed)).length).toBe(n - 1)
    expect(removed.override.rings?.remove).toEqual([k5])
    expect(entityState(removed, ringE(k5))).toBe('removed')
    expectWritable(removed)

    const k8 = keyOf(d0.base, 8)
    const added = addRingAfter(d0, k8)
    const level = shippedLevel(added)
    expect(liveRings(level).length).toBe(n + 1)
    expect(added.selection).toEqual({ kind: 'ring', key: 'ov:1' })
    const fresh = ring(level, 9)
    expect(ringKey(fresh)).toBe('ov:1')
    const a = ring(d0.base, 8).pos
    const b = ring(d0.base, 9).pos
    expect(dist(fresh.pos, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])).toBeLessThan(
      ON_GRID,
    )
    expectWritable(added)

    // A second add after the first; removing the first re-anchors the second to ring 8.
    const two = addRingAfter(added, 'ov:1')
    expect(two.override.rings?.add?.map((x) => [x.key, x.after])).toEqual([
      ['ov:1', k8],
      ['ov:2', 'ov:1'],
    ])
    const one = removeEntity(two, ringE('ov:1'))
    expect(one.override.rings?.add?.map((x) => [x.key, x.after])).toEqual([['ov:2', k8]])
    expect(liveRings(shippedLevel(one)).length).toBe(n + 1)
    expectWritable(one)
  })

  it('never below the format’s minimum ring count', async () => {
    let d = await open('rookie_01_hoverJet')
    for (let guard = 0; guard < 200; guard++) {
      const k = keyOf(shippedLevel(d), 0)
      const next = removeEntity(d, ringE(k))
      if (next === d) break
      d = next
    }
    expect(liveRings(shippedLevel(d)).length).toBe(PLAYER_COURSE_LIMITS.rings.min)
    expectWritable(d)
  })

  it('revert puts one entity back; the timer drops out on 2016’s own number; notes need words', async () => {
    const d0 = await open()
    const e = ringE(keyOf(d0.base, 3))
    const r = ring(d0.base, 3)
    const d1 = moveEntity(d0, e, [r.pos[0], r.pos[1] + 20, r.pos[2]], r.quat)
    expect(revertEntity(d1, e).override.rings).toBeUndefined()
    expect(revertEntity(d0, e)).toBe(d0)
    const t = setTimer(d0, 'timeLimit', 170)
    expect(t.override.timer).toEqual({ timeLimit: 170 })
    expect(setTimer(t, 'timeLimit', d0.base.timer.timeLimit).override.timer).toBeUndefined()
    expect(setTimer(d0, 'timeLimit', d0.base.timer.timeLimit)).toBe(d0)
    expect(shippedLevel(t).timer.timeLimit).toBe(170)
    expect(addNote(d0, '2026-09-30', '   ')).toBe(d0)
    const noted = addNote(d0, '2026-09-30', 'ring 3 up: testers clipped the ridge')
    expect(noted.override.notes).toEqual([
      { at: '2026-09-30', what: 'ring 3 up: testers clipped the ridge' },
    ])
    expectWritable(noted)
  })

  it('undo and redo through the ONE history; selecting is not an edit; saved is compared by text', async () => {
    const d0 = await open()
    let h = createHistory(d0, SHIPPED_DRAFT_KIND)
    const e = ringE(keyOf(d0.base, 1))
    h = record(h, selectEntity(h.present, e))
    expect(canUndo(h), 'a selection pushes no entry').toBe(false)
    const r = ring(d0.base, 1)
    // A drag: three steps, one entry.
    for (const dx of [5, 10, 15]) {
      h = record(h, moveEntity(h.present, e, [r.pos[0] + dx, r.pos[1], r.pos[2]], r.quat), {
        coalesce: 'move',
      })
    }
    expect(h.past.length).toBe(1)
    expect(isDirty(h)).toBe(true)
    h = undo(h)
    expect(isDirty(h)).toBe(false)
    expect(canRedo(h)).toBe(true)
    h = redo(h)
    expect(isDirty(h)).toBe(true)
    h = markSaved(h)
    expect(isDirty(h)).toBe(false)
    // Made back by hand (a new object, the same text): clean, because saved is the TEXT.
    h = record(h, moveEntity(h.present, e, r.pos, r.quat))
    h = record(h, moveEntity(h.present, e, [r.pos[0] + 15, r.pos[1], r.pos[2]], r.quat))
    expect(isDirty(h)).toBe(false)
  })
})

describe('DEV-540: warnings', () => {
  it('distanceToLine measures to the segments, not to the vertices', () => {
    const line = [
      [0, 0, 0],
      [100, 0, 0],
    ]
    expect(distanceToLine([50, 3, 0], line)).toBeCloseTo(3, 9)
    expect(distanceToLine([-4, 3, 0], line)).toBeCloseTo(5, 9)
  })

  it('on every HoverJet mission as 2016 shipped it, no ring is off the racing line', async () => {
    let judged = 0
    for (const id of generatedLevelIds()) {
      const base = await loadBaselineLevel(id)
      if (!isShippedEditable(base)) continue
      const ev = evaluateShipped(openShipped(base, sha(id), null, null).draft, null)
      expect(ev.level).not.toBeNull()
      expect(
        ev.warnings.map((w) => w.kind),
        id,
      ).toEqual([])
      judged++
    }
    expect(judged).toBeGreaterThan(0)
  })

  it('a ring moved past its trigger’s radius off the line warns, about that ring only; within it does not', async () => {
    const d0 = await open()
    const i = 6
    const r = ring(d0.base, i)
    const e = ringE(keyOf(d0.base, i))
    const R = r.trigger.radius
    const near = moveEntity(d0, e, [r.pos[0], r.pos[1] + R / 2, r.pos[2]], r.quat)
    expect(evaluateShipped(near, null).warnings).toEqual([])
    const far = moveEntity(d0, e, [r.pos[0], r.pos[1] + 4 * R, r.pos[2]], r.quat)
    const w = evaluateShipped(far, null).warnings
    expect(w.map((x) => [x.kind, x.ring])).toEqual([['ring-off-line', i]])
    expect(w[0]?.severity).toBe('warning')
    expect(w[0]?.metres).toBeGreaterThan(R)
  })

  it('ring-in-ground judges only rings the override placed', async () => {
    const d0 = await open()
    const i = 2
    const r = ring(d0.base, i)
    // A ground just under ring i's trigger: 2016's own ring there is not judged…
    const ground = { surfaceAt: () => r.trigger.pos[1] - 1 }
    expect(evaluateShipped(d0, ground).warnings.filter((w) => w.kind === 'ring-in-ground')).toEqual(
      [],
    )
    // …the same ring nudged 10 cm by the author is.
    const nudged = moveEntity(
      d0,
      ringE(keyOf(d0.base, i)),
      [r.pos[0] + 0.1, r.pos[1], r.pos[2]],
      r.quat,
    )
    const w = evaluateShipped(nudged, ground).warnings.filter((x) => x.kind === 'ring-in-ground')
    expect(w.map((x) => x.ring)).toEqual([i])
  })

  it('an override the loader refuses is one error and no level', async () => {
    const d0 = await open()
    const broken: ShippedDraft = {
      ...d0,
      override: { ...d0.override, rings: { remove: ['123'] } },
    }
    const ev = evaluateShipped(broken, null)
    expect(ev.level).toBeNull()
    expect(ev.warnings.map((w) => [w.kind, w.severity])).toEqual([['invalid', 'error']])
    expect(ev.warnings[0]?.message).toMatch(/names no ring/)
  })
})
