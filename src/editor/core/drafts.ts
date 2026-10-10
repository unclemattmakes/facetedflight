// src/editor/core/drafts.ts — drafts kept in the browser. DEV-468, E2.
//
// EDITOR.md §5.3 step 8: *"Drafts stay in the browser (localStorage, per
// device)."* DOM-free all the same: the storage is INJECTED as the three
// methods of `Storage` this uses, so the desktop editor passes
// `window.localStorage` and a test passes a Map. Every access is wrapped: a
// private window, a full quota or blocked site data makes `localStorage` throw
// or come back empty, and a draft that cannot be saved must never take the
// editor down with it (the artifact rule, and the reason `settings.ts` does the
// same). Each call reports whether it worked.
//
// Layout: one INDEX key listing the drafts (slot, name, island, when), and one
// key per draft. An autosave writes one small draft and the index, not every
// draft. Past `EDITOR_POLICY.maxDrafts` the least recently saved is dropped.
//
// Not here: *Your courses*, the library of finished and received courses, is
// DEV-467's (`game/course-library.ts`). A draft is work in progress, and may
// not validate; a library course does.

import type { Vec3Tuple } from '@/content/level-schema'
import {
  anchored,
  isCourseName,
  migrateV1Start,
  normalisePropYaw,
  normaliseYaw,
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_VERSION,
  type PlayerCourse,
  type PlayerCourseGround,
  type PlayerCourseProp,
  type PlayerCourseRingOverride,
  type PlayerCourseStart,
  readCourseGround,
} from '@/content/player-course'
import { type PlayerCourseLight, quantiseLight } from '@/content/player-course-light'
import { propEntry } from '@/content/prop-library'
import { isRecord } from '@/net/validate-kit'
import type { AuthorLap, EditorDraft } from './draft'
import { EDITOR_POLICY } from './policy'

/** The part of the Web Storage API drafts use. `window.localStorage` is one. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The index of drafts. `.v1`: bump it, and add a reader, if the layout changes. */
export const DRAFT_INDEX_KEY = 'ff2.editor.drafts.v1'
/** One draft's key. */
export const draftKey = (slot: string): string => `ff2.editor.draft.v1.${slot}`

export interface DraftSummary {
  readonly slot: string
  /** Milliseconds since the epoch, from the caller's clock. */
  readonly updated: number
  readonly name: readonly [string, string]
  readonly island: string
  readonly sky: string
  readonly points: number
}

const SLOT = /^[a-z0-9]{1,32}$/

const idString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= PLAYER_COURSE_LIMITS.idLength

const inUnit = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/**
 * Read a stored draft's course, leniently: the format's SHAPE, bounds on every
 * number and array length, but any point count from none to the most (a draft
 * need not validate). Null for anything else — a corrupt entry is dropped, not
 * repaired.
 */
export const readDraftCourse = (v: unknown): PlayerCourse | null => {
  if (!isRecord(v)) return null
  // DEV-475: a v1 draft is read and moved to v2 (its pad at its old start).
  if (v.v !== PLAYER_COURSE_VERSION && v.v !== 1) return null
  if (!idString(v.island) || !idString(v.sky)) return null
  if (v.vehicle !== 'hoverjet' || v.mode !== 'ringAttack') return null
  const L = PLAYER_COURSE_LIMITS
  const path = v.path
  if (!isRecord(path) || !Array.isArray(path.points) || path.points.length > L.points.max) {
    return null
  }
  const points: Vec3Tuple[] = []
  for (const p of path.points as unknown[]) {
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      !p.every(
        (c) => typeof c === 'number' && Number.isFinite(c) && Math.abs(c) <= L.coordinateMetres,
      )
    ) {
      return null
    }
    points.push([p[0], p[1], p[2]])
  }
  const gap = path.gap
  if (typeof gap !== 'number' || !(gap >= L.gapMetres.min && gap <= L.gapMetres.max)) return null
  // DEV-501: an anchored draft's first point is re-derived from its pad below.
  let anchor: { h: number } | null = null
  if (path.anchor !== undefined) {
    const a = path.anchor
    const H = L.anchorHeightMetres
    if (!isRecord(a) || typeof a.h !== 'number' || !(a.h >= H.min && a.h <= H.max)) return null
    anchor = { h: a.h }
  }
  const rawRings = v.rings ?? []
  if (!Array.isArray(rawRings) || rawRings.length > L.rings.max) return null
  const rings: PlayerCourseRingOverride[] = []
  for (const r of rawRings as unknown[]) {
    if (!isRecord(r) || !inUnit(r.t) || r.skip !== true) return null
    rings.push({ t: r.t, skip: true })
  }
  const finish = isRecord(v.finish) ? v.finish.t : undefined
  if (!inUnit(finish)) return null
  // DEV-475: v2's pad, or v1's `{ t }` moved to one as the format moves it.
  let start: PlayerCourseStart
  let kept = rings
  if (v.v === 1) {
    const t = isRecord(v.start) ? v.start.t : undefined
    if (!inUnit(t) || !(t < finish) || points.length === 0) return null
    const moved = migrateV1Start(points, gap, rings, t)
    start = moved.start
    kept = moved.rings
  } else {
    const s = v.start
    if (!isRecord(s) || !Array.isArray(s.pos) || s.pos.length !== 3) return null
    const pos = s.pos as unknown[]
    if (
      !pos.every(
        (c) => typeof c === 'number' && Number.isFinite(c) && Math.abs(c) <= L.coordinateMetres,
      )
    ) {
      return null
    }
    if (typeof s.yaw !== 'number' || !Number.isFinite(s.yaw)) return null
    start = {
      pos: [pos[0] as number, pos[1] as number, pos[2] as number],
      yaw: normaliseYaw(s.yaw),
    }
  }
  const T = L.timeLimitSeconds
  const timeLimit = v.timeLimit
  if (typeof timeLimit !== 'number' || !(timeLimit >= T.min && timeLimit <= T.max)) return null
  if (!isCourseName(v.name)) return null
  // DEV-476: the light, when the draft has one, in the format's own bounds.
  let light: PlayerCourseLight | null = null
  if (v.light !== undefined) {
    const l = v.light
    if (!isRecord(l) || !Array.isArray(l.tint) || l.tint.length !== 3) return null
    const az = l.sunAzimuth
    const el = l.sunElevation
    if (typeof az !== 'number' || !(az >= -180 && az <= 180)) return null
    if (typeof el !== 'number' || !(el >= 0 && el <= 90)) return null
    if (!inUnit(l.tintAmount) || !(l.tint as unknown[]).every(inUnit)) return null
    const t = l.tint as number[]
    light = quantiseLight({
      sunAzimuth: az,
      sunElevation: el,
      tint: [t[0] as number, t[1] as number, t[2] as number],
      tintAmount: l.tintAmount,
    })
  }
  // DEV-490: the draft's own island, when it has one.
  let ground: PlayerCourseGround | null = null
  if (v.ground !== undefined) {
    ground = readCourseGround(v.ground)
    if (!ground) return null
  }
  // DEV-500's water, which this reader dropped until DEV-501 (a reopened
  // draft lost its water; the link and the file kept it).
  let water: { level: number } | null = null
  if (v.water !== undefined) {
    const w = v.water
    if (!isRecord(w) || typeof w.level !== 'number' || !Number.isFinite(w.level)) return null
    water = { level: w.level }
  }
  // DEV-504's props. Read here in the SAME row as the block (this reader has
  // dropped an optional block twice: DEV-500's water until DEV-501, and it
  // would drop this one silently). Leniently, as a draft is: any kind the
  // library has, finite numbers inside the format's own bounds; a prop the
  // validator would refuse (outside the area, too near its twin) is kept for
  // the warnings to say so.
  let props: PlayerCourseProp[] | null = null
  if (v.props !== undefined) {
    if (!Array.isArray(v.props) || v.props.length > L.props.max) return null
    props = []
    for (const p of v.props as unknown[]) {
      if (!isRecord(p) || typeof p.kind !== 'string' || !propEntry(p.kind)) return null
      const pos = p.pos
      if (
        !Array.isArray(pos) ||
        pos.length !== 3 ||
        !pos.every(
          (c) => typeof c === 'number' && Number.isFinite(c) && Math.abs(c) <= L.coordinateMetres,
        )
      ) {
        return null
      }
      if (typeof p.yaw !== 'number' || !Number.isFinite(p.yaw)) return null
      if (typeof p.scale !== 'number' || !Number.isFinite(p.scale) || !(p.scale > 0)) return null
      props.push({
        kind: p.kind,
        pos: [pos[0] as number, pos[1] as number, pos[2] as number],
        yaw: normalisePropYaw(p.yaw),
        scale: p.scale,
      })
    }
  }
  return anchored({
    v: PLAYER_COURSE_VERSION,
    island: v.island,
    sky: v.sky,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: anchor ? { points, gap, anchor } : { points, gap },
    rings: kept,
    start,
    finish: { t: finish },
    timeLimit,
    name: [v.name[0], v.name[1]],
    ...(light ? { light } : {}),
    ...(ground ? { ground } : {}),
    ...(water ? { water } : {}),
    ...(props && props.length > 0 ? { props } : {}), // DEV-504
  })
}

const readAuthorLap = (v: unknown): AuthorLap | null =>
  isRecord(v) &&
  typeof v.courseId === 'string' &&
  /^pc_[0-9a-f]{12}$/.test(v.courseId) &&
  typeof v.seconds === 'number' &&
  Number.isFinite(v.seconds) &&
  v.seconds > 0
    ? { courseId: v.courseId, seconds: v.seconds }
    : null

const readSummary = (v: unknown): DraftSummary | null => {
  if (!isRecord(v)) return null
  if (typeof v.slot !== 'string' || !SLOT.test(v.slot)) return null
  if (typeof v.updated !== 'number' || !Number.isFinite(v.updated)) return null
  if (!isCourseName(v.name) || !idString(v.island) || !idString(v.sky)) return null
  if (typeof v.points !== 'number' || !Number.isInteger(v.points) || v.points < 0) return null
  return {
    slot: v.slot,
    updated: v.updated,
    name: [v.name[0], v.name[1]],
    island: v.island,
    sky: v.sky,
    points: v.points,
  }
}

/** The drafts, most recently saved first. Empty when storage is absent or unreadable. */
export const listDrafts = (storage: DraftStorage | null): DraftSummary[] => {
  if (!storage) return []
  try {
    const raw = storage.getItem(DRAFT_INDEX_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: DraftSummary[] = []
    const seen = new Set<string>()
    for (const item of parsed.slice(0, EDITOR_POLICY.maxDrafts)) {
      const s = readSummary(item)
      if (s && !seen.has(s.slot)) {
        out.push(s)
        seen.add(s.slot)
      }
    }
    return out.sort((a, b) => b.updated - a.updated)
  } catch {
    return []
  }
}

/**
 * The editor hosts' dice: a uniform integer in `[0, n)`. The core takes `randomInt`
 * as a parameter so a test can hand in a seeded one; this is the one the desk
 * and the bench hand in. `Math.random()` is fine here, never under `src/sim`.
 */
export const randomInt = (n: number): number => Math.floor(Math.random() * n)

/** A fresh slot id: `randomInt(n)` is a uniform integer in `[0, n)`. Twelve base-36 digits. */
export const newDraftSlot = (randomInt: (n: number) => number): string => {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 12; i++) s += digits[randomInt(digits.length)] ?? '0'
  return s
}

/**
 * Save `draft` in `slot` at time `now` (ms), and put it at the top of the
 * index. Evicts past `maxDrafts`. True when both writes went through.
 */
export const saveDraft = (
  storage: DraftStorage | null,
  slot: string,
  draft: EditorDraft,
  now: number,
): boolean => {
  if (!storage || !SLOT.test(slot)) return false
  try {
    const c = draft.course
    storage.setItem(
      draftKey(slot),
      JSON.stringify({
        course: c,
        selection: draft.selection,
        authorLap: draft.authorLap,
        remixedFrom: draft.remixedFrom,
      }),
    )
    const summary: DraftSummary = {
      slot,
      updated: now,
      name: [c.name[0], c.name[1]],
      island: c.island,
      sky: c.sky,
      points: c.path.points.length,
    }
    const others = listDrafts(storage).filter((d) => d.slot !== slot)
    const kept = [summary, ...others]
    const dropped = kept.splice(EDITOR_POLICY.maxDrafts)
    storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(kept))
    for (const d of dropped) {
      try {
        storage.removeItem(draftKey(d.slot))
      } catch {
        // An orphan draft is harmless: nothing lists it.
      }
    }
    return true
  } catch {
    return false
  }
}

/** The draft in `slot`, or null when it is missing or unreadable. */
export const loadDraft = (storage: DraftStorage | null, slot: string): EditorDraft | null => {
  if (!storage || !SLOT.test(slot)) return null
  try {
    const raw = storage.getItem(draftKey(slot))
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    if (!isRecord(v)) return null
    const course = readDraftCourse(v.course)
    if (!course) return null
    const n = course.path.points.length
    const selection =
      typeof v.selection === 'number' &&
      Number.isInteger(v.selection) &&
      v.selection >= 0 &&
      v.selection < n
        ? v.selection
        : null
    const remixedFrom =
      typeof v.remixedFrom === 'string' && /^pc_[0-9a-f]{12}$/.test(v.remixedFrom)
        ? v.remixedFrom
        : null
    return { course, selection, authorLap: readAuthorLap(v.authorLap), remixedFrom }
  } catch {
    return null
  }
}

/** Remove the draft in `slot` and its index entry. True when it went through. */
export const deleteDraft = (storage: DraftStorage | null, slot: string): boolean => {
  if (!storage || !SLOT.test(slot)) return false
  try {
    storage.removeItem(draftKey(slot))
    const kept = listDrafts(storage).filter((d) => d.slot !== slot)
    storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(kept))
    return true
  } catch {
    return false
  }
}

// ── DEV-889: the shelf ────────────────────────────────────────────────────
//
// Playtest 2026-10-09: five islands built, one draft reachable: the others
// were in storage and in no list. The drafts are a SHELF now (the last
// `maxDrafts`, newest first), named by course, island and time, listed in the
// Share menu, and the desk asks before a new draft pushes the oldest off.

/** "Deft Rocket · alpine · 14:32" (today) or "Deft Rocket · alpine · Oct 9, 14:32". */
export const shelfLabel = (d: DraftSummary, now: number): string => {
  const at = new Date(d.updated)
  const today = new Date(now)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const when = sameDay ? `${hh}:${mm}` : `${month[at.getMonth()]} ${at.getDate()}, ${hh}:${mm}`
  return `${d.name[0]} ${d.name[1]} · ${d.island} · ${when}`
}

/** The shelf, newest first, without the draft being edited (`except`). */
export const shelfOf = (storage: DraftStorage | null, except: string): DraftSummary[] =>
  listDrafts(storage).filter((d) => d.slot !== except)

/**
 * The draft that starting ANOTHER one would push off the shelf, or null when
 * there is room. Call it after the current draft is saved: it is on the shelf
 * and counts, and it is the newest, so the oldest is the one that goes.
 */
export const draftToDrop = (storage: DraftStorage | null): DraftSummary | null => {
  const list = listDrafts(storage)
  return list.length >= EDITOR_POLICY.maxDrafts ? (list.at(-1) ?? null) : null
}

/** A draft with nothing in it: no line (an anchored one has its pad point), no props. Moving on from one keeps nothing. */
export const isBlankDraft = (draft: EditorDraft): boolean =>
  draft.course.path.points.length <= (draft.course.path.anchor ? 1 : 0) &&
  (draft.course.props?.length ?? 0) === 0
