// tests/unit/editor-core.test.ts — the editor core. DEV-468, E2.
//
// What is asserted, and against what:
//
//  1. The POLICY, by value (`EDITOR_POLICY`), and every number it leans on,
//     against something outside this module: the clearance is the sheet's
//     `hoverHeight`, the lateral limit is `boot/app.ts`'s measured copy, and
//     the par ratio is 2016's own clean ghost re-scored.
//  2. Commands are PURE (frozen inputs), return their input on a no-op, and
//     keep the format's ranges.
//  3. Undo/redo, as a PROPERTY: any seeded command sequence undone fully is
//     the start, and redone fully is the end, entry for entry.
//  4. Warnings, on a course fitted to 2016's own `int_01` line, over synthetic
//     ground whose answer is known by construction — and 2016's own line is
//     NOT flagged as a tight turn (the outside check on that threshold).
//  5. The playtest contract: a full lap's level IS the expansion; "fly from
//     here" is a valid level; the author lap is recorded only when it should be.
//  6. Drafts in storage survive a round trip, evict, and survive a hostile or
//     throwing storage.
//  7. The core is three-free and DOM-free, by its import graph.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nearestArc } from '@/content/course-spline'
import { type Level, liveRings, validateLevel } from '@/content/level-schema'
import {
  anchorPoint,
  expandPlayerCourse,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  PLAYER_COURSE_VERSION,
  playerCourseArea,
  playerCourseId,
  playerCourseSpline,
  ringFacing,
} from '@/content/player-course'
import {
  addPoint,
  aimPad,
  authorLapOf,
  authorParTime,
  canRedo,
  canUndo,
  createHistory,
  DRAFT_INDEX_KEY,
  type DraftStorage,
  deleteDraft,
  deletePoint,
  depth,
  donorGap,
  draftFromCourse,
  EDITOR_POLICY,
  type EditorDraft,
  evaluateDraft,
  type Ground,
  groundClearance,
  type History,
  insertPoint,
  insertPointOnPath,
  isAuthorLap,
  isDirty,
  listDrafts,
  loadDraft,
  markSaved,
  movePad,
  movePoint,
  newDraft,
  newDraftSlot,
  onReturn,
  type PlaytestResult,
  playtestLevel,
  playtestRequest,
  record,
  redo,
  rerollName,
  saveDraft,
  seal,
  select,
  setFinish,
  setGap,
  setSky,
  setTimeLimit,
  tightestTurnRadius,
  toggleRingSkip,
  undo,
} from '@/editor/core'
import { HOVERJET_LAT_ACCEL_MEASURED } from '@/game/measured'
import { courseGates } from '@/game/mission'
import { validateModeContent } from '@/game/modes'
import { HOVERJET } from '@/generated/constants.generated'
import { decodeGhostClip, type GhostDoc, scoreGhost } from '@/sim/ghost'
import { cruiseSpeed } from '@/sim/hoverjet'
import { v3 } from '@/sim/math/vec3'
import slowDoc from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import { REPO, rel, walkImports } from '../../tools/test/import-graph.mjs'
import { shippedLevels } from './helpers/content'
import { fittedCourse } from './helpers/editor-course'
import { seeded as rng } from './helpers/seeded'

type V = [number, number, number]

// ── Fixtures ──────────────────────────────────────────────────────────────

const shipped: Level[] = shippedLevels()
const hoverjets = shipped.filter((l) => l.vehicle === 'hoverjet')
const int01 = shipped.find((l) => l.id === 'int_01_hoverJet') as Level

/** A valid course along 2016's own `int_01` line (DEV-478 moved it to the shared helper). */
const COURSE = fittedCourse(int01)
const DRAFT = draftFromCourse(COURSE)

/** Ground far below everything: no terrain warning can fire over it. */
const ABYSS: Ground = { surfaceAt: () => -1e5 }
/** A flat plane at `h`. */
const flat = (h: number): Ground => ({ surfaceAt: () => h })

/** mulberry32: a seeded uniform source, so every property run is replayable. */
const intOf =
  (r: () => number) =>
  (n: number): number =>
    Math.floor(r() * n)

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

// ── 1. The policy ─────────────────────────────────────────────────────────

describe('DEV-468 — the editor policy, pinned by value', () => {
  it('holds these numbers', () => {
    expect(EDITOR_POLICY).toEqual({
      undoDepth: 50,
      maxDrafts: 5, // DEV-889: the shelf
      ringOpeningSamples: 16,
      padFootprintSamples: 16,
      latAccelMeasured: 162,
      parPerAuthorSecond: 1.75,
      liftRounds: 48,
      runInSampleMetres: 4, // DEV-486
      runInMoveStepMetres: 8, // DEV-486
      anchorHeadingStepDegrees: 5, // DEV-501
    })
  })

  it('takes its ground clearance from the sheet: the HoverJet’s hoverHeight, 4 m', () => {
    expect(groundClearance()).toBe(HOVERJET.hoverMotor.hoverHeight)
    expect(groundClearance()).toBe(4)
  })

  it('judges a turn at cruise: cruise² / 162, about 50 m', () => {
    const cruise = cruiseSpeed(HOVERJET)
    expect(cruise).toBeCloseTo(89.81, 1)
    expect(tightestTurnRadius()).toBeCloseTo(cruise ** 2 / 162, 9)
    expect(tightestTurnRadius()).toBeGreaterThan(49)
    expect(tightestTurnRadius()).toBeLessThan(51)
  })

  it('takes the lateral limit from the one measured home it shares with boot/app/pins.ts', () => {
    // DEV-027's measurement had two copies held equal by a regex over the
    // app's source. It has one (`game/measured.ts`, DEV-741); the pin on the
    // value is the policy's `toEqual` above.
    expect(EDITOR_POLICY.latAccelMeasured).toBe(HOVERJET_LAT_ACCEL_MEASURED)
  })

  it('takes the par ratio from 2016’s one clean flight, rounded down', () => {
    const f = int01.finish as NonNullable<Level['finish']>
    const r = scoreGhost(decodeGhostClip(slowDoc as unknown as GhostDoc), {
      gates: courseGates(int01),
      finish: { x: f.pos[0], y: f.pos[1], z: -f.pos[2], radius: f.radius },
      worldOffset: [int01.worldOffset[0], int01.worldOffset[1], int01.worldOffset[2]],
      startTime: 0.55,
    })
    expect(r.seconds).not.toBeNull()
    const seconds = r.seconds as number
    const ratio = int01.timer.bonusParTime / seconds
    expect(ratio).toBeCloseTo(1.757, 2)
    expect(EDITOR_POLICY.parPerAuthorSecond).toBeLessThanOrEqual(ratio)
    expect(ratio - EDITOR_POLICY.parPerAuthorSecond).toBeLessThan(ratio * 0.01)
    // …and on int_01 that lap gives back 2016's own par.
    expect(authorParTime(seconds, int01.timer.timeLimit)).toBe(int01.timer.bonusParTime)
  })

  it('premise: 2016’s par is the time limit on every HoverJet mission, whatever the length', () => {
    const lengths = hoverjets.map((l) => {
      const r = (l.route ?? []) as V[]
      let s = 0
      for (let i = 1; i < r.length; i++) {
        const a = r[i - 1] as V
        const b = r[i] as V
        s += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      }
      return s
    })
    for (const l of hoverjets) expect(l.timer.bonusParTime, l.id).toBe(l.timer.timeLimit)
    // Routes 1.5x apart in length share one par: a length rule would be invented.
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThan(1.5)
  })

  it('never proposes a par past the time limit', () => {
    expect(authorParTime(60, 180)).toBe(105)
    expect(authorParTime(150, 180)).toBe(180)
    expect(authorParTime(1, 30)).toBe(2)
  })
})

// ── 2. Commands ───────────────────────────────────────────────────────────

describe('commands are pure (draft) → draft', () => {
  it('starts a new draft from the donor: its island, its spacing, its time limit, one point: the pad’s (DEV-501)', () => {
    const d = newDraft(int01, ['Amber', 'Heron'])
    expect(d.course.island).toBe('simonet')
    expect(d.course.sky).toBe('int_01_hoverJet')
    expect(d.course.path.anchor).toEqual({ h: 27 })
    expect(d.course.path.points).toEqual([
      anchorPoint(d.course.start, d.course.path.gap, { h: 27 }),
    ])
    expect(d.course.timeLimit).toBe(int01.timer.timeLimit)
    // 2016 spaced its rings 397–522 m; the default is the donor's own mean chord.
    for (const l of hoverjets) {
      const g = donorGap(l)
      expect(g, l.id).toBeGreaterThanOrEqual(PLAYER_COURSE_LIMITS.gapMetres.min)
      expect(g, l.id).toBeLessThanOrEqual(PLAYER_COURSE_LIMITS.gapMetres.max)
    }
    expect(donorGap(int01)).toBeGreaterThan(350)
    expect(donorGap(int01)).toBeLessThan(550)
  })

  it('never mutates the input, and returns it on a no-op', () => {
    const d = deepFreeze(draftFromCourse(COURSE))
    const n = COURSE.path.points.length
    const p0 = COURSE.path.points[0] as V
    const calls: [string, () => EditorDraft][] = [
      ['addPoint', () => addPoint(d, [0, 500, 0])],
      ['insertPoint', () => insertPoint(d, 1, [0, 500, 0])],
      ['insertPointOnPath', () => insertPointOnPath(d, 0.3)],
      ['movePoint', () => movePoint(d, 2, [1, 2, 3])],
      ['deletePoint', () => deletePoint(d, 1)],
      ['select', () => select(d, 3)],
      ['setGap', () => setGap(d, 300)],
      ['movePad', () => movePad(d, [1, 2, 3])],
      ['aimPad', () => aimPad(d, 45)],
      ['setFinish', () => setFinish(d, 0.8)],
      ['toggleRingSkip', () => toggleRingSkip(d, 0.4)],
      ['setSky', () => setSky(d, 'adv_02_hoverJet')],
      ['setTimeLimit', () => setTimeLimit(d, 240)],
      ['rerollName', () => rerollName(d, () => 3)],
    ]
    for (const [name, call] of calls) {
      const out = call()
      expect(out, name).not.toBe(d)
    }
    expect(d.course.path.points.length).toBe(n)
    // No-ops return the SAME object, so history can see them.
    expect(movePoint(d, 0, [...p0] as V)).not.toBe(d) // moves selection to 0
    const sel0 = select(d, 0)
    expect(movePoint(sel0, 0, [...p0] as V)).toBe(sel0)
    expect(setGap(d, d.course.path.gap)).toBe(d)
    expect(setTimeLimit(d, d.course.timeLimit)).toBe(d)
    expect(setSky(d, d.course.sky)).toBe(d)
    expect(deletePoint(d, 999)).toBe(d)
    expect(movePoint(d, 0, [Number.NaN, 0, 0])).toBe(d)
    expect(select(d, 999).selection).toBeNull()
  })

  it('keeps the numbers a control sets inside the format’s limits', () => {
    const L = PLAYER_COURSE_LIMITS
    expect(setGap(DRAFT, 5).course.path.gap).toBe(L.gapMetres.min)
    expect(setGap(DRAFT, 1e6).course.path.gap).toBe(L.gapMetres.max)
    expect(setTimeLimit(DRAFT, 1).course.timeLimit).toBe(L.timeLimitSeconds.min)
    expect(setTimeLimit(DRAFT, 1e6).course.timeLimit).toBe(L.timeLimitSeconds.max)
    const f = setFinish(DRAFT, -1)
    expect(f.course.finish.t).toBe(PLAYER_COURSE_SHAPE.tQuantum)
    // DEV-475: a heading is wrapped onto the format's range and grid.
    expect(aimPad(DRAFT, 190).course.start.yaw).toBe(-170)
    expect(aimPad(DRAFT, -180.04).course.start.yaw).toBe(-180)
    expect(aimPad(DRAFT, 179.97).course.start.yaw).toBe(-180)
    expect(aimPad(DRAFT, DRAFT.course.start.yaw)).toBe(DRAFT)
    expect(movePad(DRAFT, [...DRAFT.course.start.pos] as V)).toBe(DRAFT)
    expect(movePad(DRAFT, [Number.NaN, 0, 0])).toBe(DRAFT)
  })

  it('stops adding at the most points a course may hold', () => {
    let d = newDraft(int01, ['Amber', 'Heron'])
    for (let i = 0; i < PLAYER_COURSE_LIMITS.points.max + 5; i++) d = addPoint(d, [i * 10, 300, 0])
    expect(d.course.path.points.length).toBe(PLAYER_COURSE_LIMITS.points.max)
    expect(d.selection).toBe(PLAYER_COURSE_LIMITS.points.max - 1)
  })

  it('deletes down to nothing, the selection following the gap', () => {
    let d = select(DRAFT, 2)
    d = deletePoint(d, 2)
    expect(d.selection).toBe(2)
    expect(d.course.path.points[2]).toEqual(COURSE.path.points[3])
    while (d.course.path.points.length > 0) d = deletePoint(d, d.course.path.points.length - 1)
    expect(d.selection).toBeNull()
  })

  it('inserts on the line ON the line, in the segment that holds it', () => {
    const before = playerCourseSpline(COURSE)
    const t = 0.37
    const d = insertPointOnPath(DRAFT, t)
    const i = d.selection as number
    const p = d.course.path.points[i] as V
    // The new point is where the old curve was at t…
    const on = nearestArc(before, v3(p[0], p[1], p[2]))
    expect(Math.abs(on / before.length - t)).toBeLessThan(1e-3)
    // …and between the control points either side of it along the path.
    const arcOf = (q: V): number => nearestArc(before, v3(q[0], q[1], q[2]))
    expect(arcOf(d.course.path.points[i - 1] as V)).toBeLessThan(on)
    expect(arcOf(d.course.path.points[i + 1] as V)).toBeGreaterThan(on)
  })

  it('skips a ring and puts it back, matched within half a gap as the expansion matches it', () => {
    const level = expandPlayerCourse(COURSE, int01)
    const spline = playerCourseSpline(COURSE)
    const ring = liveRings(level)[3] as ReturnType<typeof liveRings>[number]
    const t = nearestArc(spline, v3(ring.pos[0], ring.pos[1], ring.pos[2])) / spline.length
    const skipped = toggleRingSkip(DRAFT, t)
    expect(skipped.course.rings).toHaveLength(1)
    expect(liveRings(expandPlayerCourse(skipped.course, int01))).toHaveLength(
      liveRings(level).length - 1,
    )
    // A t a few metres off the ring's still names it.
    const back = toggleRingSkip(skipped, t + 5 / spline.length)
    expect(back.course.rings).toHaveLength(0)
  })

  it('rerolls a name from the lists, from the caller’s dice', () => {
    const d = rerollName(DRAFT, intOf(rng(7)))
    expect(d.course.name).not.toEqual(DRAFT.course.name)
    expect(rerollName(DRAFT, intOf(rng(7))).course.name).toEqual(d.course.name)
  })
})

// ── 3. Undo and redo, as a property ───────────────────────────────────────

/** One random command, as the front-end would record it. */
const step = (h: History, r: () => number): History => {
  const d = h.present
  const n = d.course.path.points.length
  const pick = intOf(r)
  const k = pick(11)
  const pt = (): V => [
    Math.round(r() * 4000 - 2000),
    Math.round(100 + r() * 400),
    Math.round(r() * 4000 - 2000),
  ]
  switch (k) {
    case 0:
      return record(h, addPoint(d, pt()))
    case 1:
      return record(h, insertPoint(d, pick(n + 1), pt()))
    case 2: {
      if (n === 0) return h
      // A drag: many moves, one entry.
      const i = pick(n)
      let out = h
      const moves = 1 + pick(20)
      for (let m = 0; m < moves; m++)
        out = record(out, movePoint(out.present, i, pt()), { coalesce: `move:${i}` })
      return seal(out)
    }
    case 3:
      return n > 0 ? record(h, deletePoint(d, pick(n))) : h
    case 4:
      return record(h, setGap(d, 60 + pick(900)))
    case 5:
      return record(h, movePad(d, pt()))
    case 6:
      return record(h, setFinish(d, 0.5 + r() * 0.5))
    case 7:
      return record(h, setTimeLimit(d, 30 + pick(870)))
    case 8:
      return record(h, rerollName(d, pick))
    case 9:
      return record(h, select(d, n > 0 ? pick(n) : null))
    default:
      return n >= 2 ? record(h, toggleRingSkip(d, r())) : h
  }
}

describe('undo and redo', () => {
  it('undone fully is the start, and redone fully is the end — 200 seeded sequences', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const start = newDraft(int01, ['Amber', 'Heron'])
      let h = createHistory(start)
      const length = 1 + intOf(r)(40)
      for (let i = 0; i < length; i++) h = step(h, r)
      // Every entry in reach, then fully back…
      const entries = depth(h)
      expect(entries).toBeLessThanOrEqual(EDITOR_POLICY.undoDepth)
      const end = h.present
      let u = h
      while (canUndo(u)) u = undo(u)
      expect(canUndo(u)).toBe(false)
      expect(u.present.course, `seed ${seed}`).toEqual(start.course)
      expect(u.present.course, `seed ${seed}`).toBe(start.course)
      // …and fully forward, to the same objects.
      let f = u
      let redone = 0
      while (canRedo(f)) {
        f = redo(f)
        redone++
      }
      expect(redone, `seed ${seed}`).toBe(entries)
      expect(f.present.course, `seed ${seed}`).toBe(end.course)
    }
  })

  it('replays each step exactly: undo then redo is the identity at every depth', () => {
    const r = rng(99)
    let h = createHistory(draftFromCourse(COURSE))
    for (let i = 0; i < 30; i++) h = step(h, r)
    const trail: EditorDraft['course'][] = [h.present.course]
    let u = h
    while (canUndo(u)) {
      u = undo(u)
      trail.push(u.present.course)
    }
    let f = u
    for (let i = trail.length - 1; i >= 0; i--) {
      expect(f.present.course).toBe(trail[i])
      f = redo(f)
    }
  })

  it('coalesces a drag into one entry, and a sealed second drag into another', () => {
    let h = createHistory(DRAFT)
    for (let m = 0; m < 300; m++)
      h = record(h, movePoint(h.present, 2, [m, 300, m]), { coalesce: 'move:2' })
    expect(depth(h)).toBe(1)
    h = seal(h)
    for (let m = 0; m < 10; m++)
      h = record(h, movePoint(h.present, 2, [m, 400, m]), { coalesce: 'move:2' })
    expect(depth(h)).toBe(2)
    expect(undo(undo(h)).present.course).toBe(DRAFT.course)
  })

  it('records no entry for a no-op or a selection, and a new edit clears redo', () => {
    let h = createHistory(DRAFT)
    h = record(h, setGap(h.present, h.present.course.path.gap))
    h = record(h, select(h.present, 4))
    expect(depth(h)).toBe(0)
    expect(h.present.selection).toBe(4)
    h = record(h, setGap(h.present, 300))
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = record(h, setTimeLimit(h.present, 200))
    expect(canRedo(h)).toBe(false)
  })

  it('keeps at most undoDepth entries, dropping the oldest', () => {
    let h = createHistory(DRAFT)
    for (let i = 0; i < EDITOR_POLICY.undoDepth + 20; i++) h = record(h, setGap(h.present, 100 + i))
    expect(depth(h)).toBe(EDITOR_POLICY.undoDepth)
    while (canUndo(h)) h = undo(h)
    expect(h.present.course.path.gap).toBe(100 + 19)
  })

  it('is dirty after an edit, clean after a save, and clean again when undone to the save', () => {
    let h = createHistory(DRAFT)
    expect(isDirty(h)).toBe(false)
    h = record(h, setGap(h.present, 300))
    expect(isDirty(h)).toBe(true)
    h = markSaved(h)
    expect(isDirty(h)).toBe(false)
    h = record(h, setGap(h.present, 310))
    expect(isDirty(h)).toBe(true)
    h = undo(h)
    expect(isDirty(h)).toBe(false)
  })
})

// ── 4. Warnings ───────────────────────────────────────────────────────────

describe('warnings', () => {
  it('finds nothing wrong with 2016’s own line over ground far below — including no tight turn', () => {
    const e = evaluateDraft(DRAFT, int01, ABYSS)
    expect(e.level).not.toBeNull()
    expect(e.course).not.toBeNull()
    expect(e.courseId).toBe(playerCourseId(COURSE))
    // DEV-475: the pad stands over the same abyss, and says so; nothing else does.
    expect(e.warnings.filter((w) => w.severity !== 'note').map((w) => w.kind)).toEqual([
      'pad-slope',
    ])
  })

  it('flags a ring exactly when the ground reaches its opening plus the clearance', () => {
    const level = expandPlayerCourse(COURSE, int01)
    const ring = liveRings(level)[0] as ReturnType<typeof liveRings>[number]
    const r = ring.trigger.radius
    const c = ring.trigger.pos
    const f = ringFacing(ring.quat)
    // The opening's lowest rim point over flat ground, for this ring's tilt.
    const vertical = Math.sqrt(1 - f.y * f.y) // the disc's vertical reach per metre of radius
    const bottom = c[1] - r * vertical
    const eps = 0.05
    const ringOnly = (h: number) =>
      evaluateDraft(DRAFT, int01, {
        // Ground only under ring 0: a disc of 3r round its centre.
        surfaceAt: (x, z) => (Math.hypot(x - c[0], z - c[2]) < 3 * r ? h : -1e5),
      }).warnings.filter((w) => w.kind === 'ring-in-ground')
    expect(ringOnly(bottom - groundClearance() - eps)).toEqual([])
    const hit = ringOnly(bottom - groundClearance() + eps)
    expect(hit).toHaveLength(1)
    expect(hit[0]?.ring).toBe(0)
    expect(hit[0]?.metres).toBeGreaterThan(0)
    expect(hit[0]?.metres).toBeLessThan(0.2)
  })

  it('flags every ring, and the line, when the ground is at the rings’ height', () => {
    const level = expandPlayerCourse(COURSE, int01)
    const top = Math.max(...liveRings(level).map((r) => r.pos[1]))
    const e = evaluateDraft(DRAFT, int01, flat(top))
    const rings = e.warnings.filter((w) => w.kind === 'ring-in-ground')
    expect(rings).toHaveLength(liveRings(level).length)
    // DEV-478: a line under the ground is its own kind.
    const line = e.warnings.filter((w) => w.kind === 'line-under-ground')
    expect(line.length).toBeGreaterThan(0)
    for (const w of line) {
      expect(w.at).not.toBeNull()
      // DEV-486: the run-in's stretches carry `runIn`, the line's `span`.
      if (w.runIn) {
        expect(w.span).toBeUndefined()
        expect(w.runIn[0]).toBeGreaterThanOrEqual(0)
        expect(w.runIn[1]).toBeLessThanOrEqual(1)
        continue
      }
      expect(w.span?.[0]).toBeGreaterThanOrEqual(-1e-6)
      expect(w.span?.[1]).toBeLessThanOrEqual(COURSE.finish.t + 1e-3)
    }
  })

  it('flags a point outside the boundary once, with its place, and the course as unflyable', () => {
    const area = playerCourseArea(int01)
    if (area?.kind !== 'sphere') throw new Error('int_01 has a sphere boundary')
    const out: V = [area.centre[0] + area.radius * 1.5, 300, area.centre[2]]
    const d = movePoint(DRAFT, 3, out)
    const e = evaluateDraft(d, int01, ABYSS)
    expect(e.level).toBeNull()
    const mine = e.warnings.filter((w) => w.point === 3)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.kind).toBe('point-outside')
    expect(mine[0]?.severity).toBe('error')
    expect(mine[0]?.at).toEqual(out)
    expect(e.warnings[0]?.severity).toBe('error')
  })

  it('flags a hairpin tighter than the jet holds at cruise, and not a wide bend', () => {
    const R = tightestTurnRadius()
    const c = int01.spawn.pos
    const bend = (radius: number): EditorDraft => {
      // A straight in, a half circle, a straight out, every point one arc
      // chord apart: uniform Catmull-Rom overshoots where neighbouring spans
      // differ in length, and that kink is real curve (the warning sees it).
      const chord = 2 * radius * Math.sin(Math.PI / 16)
      const pts: V[] = []
      for (let k = 4; k >= 1; k--) pts.push([c[0] - radius, 400, c[2] + k * chord])
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI - (Math.PI * k) / 8
        pts.push([c[0] + radius * Math.cos(a), 400, c[2] - radius * Math.sin(a)])
      }
      for (let k = 1; k <= 4; k++) pts.push([c[0] + radius, 400, c[2] + k * chord])
      return draftFromCourse({
        ...COURSE,
        path: { points: pts, gap: 100 },
        start: { pos: pts[0] as V, yaw: 0 },
        finish: { t: 1 },
      })
    }
    const tight = evaluateDraft(bend(R * 0.5), int01, ABYSS).warnings.filter(
      (w) => w.kind === 'tight-turn',
    )
    expect(tight.length).toBeGreaterThan(0)
    expect(tight[0]?.metres).toBeLessThan(R)
    const wide = evaluateDraft(bend(R * 3), int01, ABYSS).warnings.filter(
      (w) => w.kind === 'tight-turn',
    )
    expect(wide).toEqual([])
  })

  it('notes a finish with less line beyond it than the gate’s own radius', () => {
    const atEnd = evaluateDraft(setFinish(DRAFT, 1), int01, ABYSS)
    const w = atEnd.warnings.filter((x) => x.kind === 'finish-no-runoff')
    expect(w).toHaveLength(1)
    expect(w[0]?.severity).toBe('note')
    expect(w[0]?.metres).toBeCloseTo((int01.finish as NonNullable<Level['finish']>).radius, 3)
    expect(
      evaluateDraft(DRAFT, int01, ABYSS).warnings.some((x) => x.kind === 'finish-no-runoff'),
    ).toBe(false)
  })

  it('never throws, on an empty draft or on any seeded edit sequence', () => {
    const empty = newDraft(int01, ['Amber', 'Heron'])
    const e = evaluateDraft(empty, int01, ABYSS)
    expect(e.level).toBeNull()
    expect(e.warnings.length).toBeGreaterThan(0)
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      let h = createHistory(empty)
      for (let i = 0; i < 25; i++) h = step(h, r)
      expect(() => evaluateDraft(h.present, int01, flat(r() * 300)), `seed ${seed}`).not.toThrow()
    }
  })
})

// ── 5. The playtest contract ──────────────────────────────────────────────

const result = (draft: EditorDraft, over: Partial<PlaytestResult> = {}): PlaytestResult => {
  const rings = liveRings(expandPlayerCourse(draft.course, int01)).length
  return {
    courseId: playerCourseId(draft.course),
    fromT: null,
    finished: true,
    seconds: 90,
    ringsTaken: rings,
    ringsTotal: rings,
    ...over,
  }
}

describe('the playtest contract', () => {
  it('flies the ordinary expansion for a full lap', () => {
    expect(playtestLevel(COURSE, int01, null)).toEqual(expandPlayerCourse(COURSE, int01))
    const req = playtestRequest(DRAFT, int01)
    expect(req?.courseId).toBe(playerCourseId(COURSE))
    expect(playtestRequest(newDraft(int01, ['Amber', 'Heron']), int01)).toBeNull()
  })

  it('flies from here: spawn on the line at fromT, only the rings ahead, still a valid level', () => {
    const full = expandPlayerCourse(COURSE, int01)
    const t = COURSE.finish.t / 2
    const level = playtestLevel(COURSE, int01, t)
    expect(() => validateLevel(level)).not.toThrow()
    expect(() => validateModeContent(level)).not.toThrow()
    const spline = playerCourseSpline(COURSE)
    const at = level.spawn.pos
    expect(nearestArc(spline, v3(at[0], at[1], at[2])) / spline.length).toBeCloseTo(t, 3)
    const kept = liveRings(level)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(liveRings(full).length)
    for (const ring of kept) {
      expect(
        nearestArc(spline, v3(ring.pos[0], ring.pos[1], ring.pos[2])) / spline.length,
      ).toBeGreaterThan(t)
    }
    expect(kept.map((r) => r.i)).toEqual(kept.map((_, i) => i))
  })

  it('records a clean lap from the start as the author lap, and keeps the best', () => {
    const lap = onReturn(DRAFT, result(DRAFT))
    expect(authorLapOf(lap)).toEqual({ courseId: playerCourseId(COURSE), seconds: 90 })
    expect(authorLapOf(onReturn(lap, result(DRAFT, { seconds: 95 })))?.seconds).toBe(90)
    expect(authorLapOf(onReturn(lap, result(DRAFT, { seconds: 80 })))?.seconds).toBe(80)
  })

  it('does not record a lap that missed a ring, did not finish, started later, or flew another course', () => {
    const r = result(DRAFT)
    expect(isAuthorLap(DRAFT, r)).toBe(true)
    for (const bad of [
      { ringsTaken: r.ringsTotal - 1 },
      { finished: false },
      { seconds: null },
      { fromT: 0.1 },
      // Fly-from-here AT the line's first point is still a part, not the lap
      // from the pad (DEV-475).
      { fromT: 0 },
      { courseId: 'pc_000000000000' },
    ] as Partial<PlaytestResult>[]) {
      expect(isAuthorLap(DRAFT, { ...r, ...bad }), JSON.stringify(bad)).toBe(false)
      expect(onReturn(DRAFT, { ...r, ...bad })).toBe(DRAFT)
    }
  })

  it('holds the author lap only for the course it was flown on, through undo', () => {
    let h = createHistory(DRAFT)
    h = record(h, onReturn(h.present, result(h.present)))
    expect(authorLapOf(h.present)).not.toBeNull()
    h = record(h, setGap(h.present, 450))
    expect(authorLapOf(h.present)).toBeNull()
    h = undo(h)
    expect(authorLapOf(h.present)).not.toBeNull()
  })
})

// ── 6. Drafts in storage ──────────────────────────────────────────────────

const memory = (): DraftStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('drafts', () => {
  it('round-trips a draft, author lap and all, and lists it', () => {
    const s = memory()
    const d = { ...onReturn(select(DRAFT, 2), result(DRAFT)), remixedFrom: 'pc_0123456789ab' }
    expect(saveDraft(s, 'abc', d, 1000)).toBe(true)
    expect(loadDraft(s, 'abc')).toEqual(d)
    expect(listDrafts(s)).toEqual([
      {
        slot: 'abc',
        updated: 1000,
        name: ['Amber', 'Heron'],
        island: 'simonet',
        sky: 'int_01_hoverJet',
        points: COURSE.path.points.length,
      },
    ])
    // An empty draft is a draft too.
    const empty = newDraft(int01, ['Amber', 'Heron'])
    expect(saveDraft(s, 'def', empty, 2000)).toBe(true)
    expect(loadDraft(s, 'def')).toEqual(empty)
    expect(listDrafts(s).map((x) => x.slot)).toEqual(['def', 'abc'])
    expect(deleteDraft(s, 'abc')).toBe(true)
    expect(listDrafts(s).map((x) => x.slot)).toEqual(['def'])
    expect(loadDraft(s, 'abc')).toBeNull()
  })

  it('drops the least recently saved past maxDrafts', () => {
    const s = memory()
    const slot = newDraftSlot(intOf(rng(3)))
    expect(slot).toMatch(/^[a-z0-9]{12}$/)
    for (let i = 0; i < EDITOR_POLICY.maxDrafts + 3; i++) saveDraft(s, `s${i}`, DRAFT, i)
    const list = listDrafts(s)
    expect(list).toHaveLength(EDITOR_POLICY.maxDrafts)
    expect(list.at(-1)?.slot).toBe('s3')
    expect(s.map.has('ff2.editor.draft.v1.s0')).toBe(false)
  })

  it('survives corrupt entries, a throwing storage and no storage at all', () => {
    const s = memory()
    s.map.set(DRAFT_INDEX_KEY, '{not json')
    expect(listDrafts(s)).toEqual([])
    s.map.set(
      'ff2.editor.draft.v1.bad',
      JSON.stringify({ course: { ...COURSE, v: PLAYER_COURSE_VERSION + 1 } }),
    )
    expect(loadDraft(s, 'bad')).toBeNull()
    s.map.set(
      'ff2.editor.draft.v1.bad',
      JSON.stringify({ course: { ...COURSE, path: { points: [[1, 2]], gap: 400 } } }),
    )
    expect(loadDraft(s, 'bad')).toBeNull()
    const boom: DraftStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(saveDraft(boom, 'abc', DRAFT, 1)).toBe(false)
    expect(loadDraft(boom, 'abc')).toBeNull()
    expect(listDrafts(boom)).toEqual([])
    expect(deleteDraft(boom, 'abc')).toBe(false)
    expect(saveDraft(null, 'abc', DRAFT, 1)).toBe(false)
    expect(listDrafts(null)).toEqual([])
    expect(saveDraft(s, '../escape', DRAFT, 1)).toBe(false)
  })
})

// ── 7. Three-free and DOM-free ────────────────────────────────────────────

describe('the core runs in node', () => {
  it('reaches no three, no render module and no DOM global through its imports', () => {
    const dom = /\b(document|window|navigator|localStorage|requestAnimationFrame)\b/
    for (const node of walkImports(path.join(REPO, 'src', 'editor', 'core', 'index.ts'))) {
      const file = rel(node.file)
      expect(file.startsWith('src/render/'), file).toBe(false)
      const code = fs
        .readFileSync(node.file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join('\n')
      expect(/from\s+['"]three/.test(code), file).toBe(false)
      if (file.startsWith('src/editor/core/')) expect(dom.test(code), file).toBe(false)
    }
  })
})
