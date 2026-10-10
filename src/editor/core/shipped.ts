// src/editor/core/shipped.ts — a SHIPPED mission as a draft: 2016's level and
// an override over it. DEV-540 (plan/SHIPPED-COURSE-EDITS.md §4.2).
//
// Matt, 2026-09-29: *"we should make our current shipped levels be able to be
// editable in our level editor. (i have no other way of iterating those levels
// based on feedback)"*. DEV-538 made the format (`content/level-override.ts`)
// and DEV-539 the dev server's write; this is what the editor holds while he
// edits one.
//
// ── Not a player course ──────────────────────────────────────────────────
//
// A shipped mission is NOT converted into a spline recipe: a refit moves every
// ring by up to 8.5 m on `int_01` (DEV-466's oracle), which is a diff Matt did
// not make, and it would drop what the recipe has no field for — the
// hand-placed turn indicators and orbs (§4.1). So the draft is the baseline
// `Level` as 2016 shipped it plus a `LevelOverride`, and the level the desk
// draws and flies is `applyOverride(base, override)`: the loader's own
// function, so what the editor shows is what `loadLevel` will load once the
// file is written.
//
// ── Commands ──────────────────────────────────────────────────────────────
//
// Pure `ShippedDraft → ShippedDraft`, as `commands.ts`'s are: a command that
// changes nothing returns its INPUT, so `history.record` pushes no entry for
// it, and the result shares what did not change. They are recorded in the
// same `History` as a player course's (`SHIPPED_DRAFT_KIND`), so undo and redo
// are the same code. What they write is always an override the validator
// takes: poses on the format's own quanta (`OVERRIDE_SHAPE`), a moved entity
// put back on 2016's pose drops out of the file rather than being written as a
// move of nothing, and a block left empty goes. So a draft with no edit is an
// override with no edit, and its text is the text the writer would write.
//
// ── The line (DEV-541) ────────────────────────────────────────────────────
//
// The AI racers and the player's autopilot fly `level.route`, not ring to ring
// (§4.4), so a ring moved without its line is a ring the racers take by the
// missed-ring recovery — flying past its place on the line and turning back
// for it (`sim/route.ts`). "Edit the line" (`editLine`) seeds the file's
// `route.points` by `fitFlight` over 2016's own line: at most the format's 64
// control points within `FIT_POLICY.toleranceMetres` of it, both ways. From
// then on each control point is an entity (`{ kind: 'point', index }`) moved,
// inserted and deleted like a ring, and the loader resamples the curve every
// 25 m (`overrideRoute`). "Snap ring to line" (`snapRingToLine`) stands a ring
// on the nearest point of the line, facing along it: `placeRing`'s pose
// (`ringPoseAlong`). Rings never follow the line on their own (§4.4).
//
// THREE-FREE AND DOM-FREE, like the rest of `core/` (`draft.ts`'s header).

import { buildCourseSpline } from '@/content/course-spline'
import {
  applyOverride,
  canonicalOverrideText,
  canonicalPose,
  isAddedKey,
  type LevelOverride,
  nextAddedKey,
  OVERRIDE_VERSION,
  type OverrideAdd,
  type OverrideEntities,
  type OverridePose,
  quantisePos,
  ringKey,
  routeIssues,
  turnIndicatorKey,
  validateOverride,
} from '@/content/level-override'
import {
  type Level,
  liveRings,
  type Ring,
  type TurnIndicator,
  type Vec3Tuple,
  validateLevel,
} from '@/content/level-schema'
import {
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  quantise,
  ringPoseAlong,
} from '@/content/player-course'
import { validateModeContent } from '@/game/modes'
import type { DraftStorage } from './drafts'
import { type FlightFit, fitFlight } from './fit'
import type { DraftKind } from './history'
import { groundClearance } from './policy'
import { type EditorWarning, type Ground, ringIntrusion } from './warnings'

// ── The draft ─────────────────────────────────────────────────────────────

/**
 * What can be picked: a ring or a turn indicator by its override key, the
 * finish, or (DEV-541) control point `index` of the file's own line.
 */
export type ShippedEntity =
  | { readonly kind: 'ring'; readonly key: string }
  | { readonly kind: 'turn'; readonly key: string }
  | { readonly kind: 'finish' }
  | { readonly kind: 'point'; readonly index: number }

/** Are these the same pick? */
export const sameEntity = (a: ShippedEntity | null, b: ShippedEntity | null): boolean => {
  if (a === b) return true
  if (a === null || b === null || a.kind !== b.kind) return false
  if (a.kind === 'finish') return true
  if (a.kind === 'point') return a.index === (b as { index: number }).index
  return a.key === (b as { key: string }).key
}

export interface ShippedDraft {
  /** The mission as 2016 shipped it: `loadBaselineLevel(id)`. Never edited. */
  readonly base: Level
  /** What the author changed. On the format's quanta, with no empty block. */
  readonly override: LevelOverride
  /** The picked entity, or null. Not an edit. */
  readonly selection: ShippedEntity | null
}

/**
 * The override's text as the writer would write it, or null when it holds no
 * edit at all (nothing to save, and nothing that needs a file).
 */
export const overrideText = (ov: LevelOverride): string | null => {
  const { $schema: _s, v: _v, mission: _m, base: _b, ...edits } = ov
  if (Object.keys(edits).length === 0) return null
  const checked = validateOverride(ov)
  return checked.ok ? canonicalOverrideText(checked.override) : null
}

/**
 * The history's kind for a shipped draft: the override is the edit, and the
 * saved part is its TEXT, compared by value — so an edit made and then made
 * back by hand is clean again, and a draft with no edit over no file is clean.
 */
export const SHIPPED_DRAFT_KIND: DraftKind<ShippedDraft> = {
  edits: (d) => [d.override],
  saved: (d) => overrideText(d.override),
}

/** The override of nothing, pinned to `baseSha`. */
export const emptyOverride = (base: Level, baseSha: string): LevelOverride => ({
  $schema: './_override.schema.json',
  v: OVERRIDE_VERSION,
  mission: base.id,
  base: baseSha,
})

/**
 * The level the desk draws and flies: the loader's own chain for an overridden
 * mission (`loadLevelFrom`: `applyOverride`, `validateLevel` again, then
 * `validateModeContent`), so the draft is the level `loadLevel` will hand the
 * game once the file is written. Throws as the loader does.
 */
export const shippedLevel = (d: ShippedDraft): Level =>
  validateModeContent(validateLevel(applyOverride(d.base, d.override)))

/** {@link shippedLevel}, or the refusal's message. */
export const tryShippedLevel = (
  d: ShippedDraft,
):
  | { readonly level: Level; readonly error: null }
  | { readonly level: null; readonly error: string } => {
  try {
    return { level: shippedLevel(d), error: null }
  } catch (err) {
    return { level: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Is this mission one the door opens: a generated HoverJet mission (§9: "HoverJet missions only"). */
export const isShippedEditable = (level: Level): boolean =>
  level.vehicle === 'hoverjet' &&
  liveRings(level).length > 0 &&
  level.finish?.shape === 'sphereUnion'

// ── Opening ───────────────────────────────────────────────────────────────

/** What this browser keeps of a shipped draft between loads (§4.2: "a reload loses nothing"). */
export interface StoredShipped {
  /** The file's text the draft was opened from, or null for no file: a changed file wins. */
  readonly from: string | null
  readonly override: unknown
}

/** `localStorage`'s key for mission `id`'s shipped draft, beside the player drafts. */
export const shippedDraftKey = (id: string): string => `ff2.editor.shipped.v1.${id}`

export const saveShippedDraft = (
  storage: DraftStorage | null,
  d: ShippedDraft,
  from: string | null,
): void => {
  if (!storage) return
  try {
    const stored: StoredShipped = { from, override: d.override }
    storage.setItem(shippedDraftKey(d.base.id), JSON.stringify(stored))
  } catch {
    // Full or blocked storage: the draft lives until the tab closes.
  }
}

export const loadShippedDraft = (
  storage: DraftStorage | null,
  id: string,
): StoredShipped | null => {
  if (!storage) return null
  try {
    const text = storage.getItem(shippedDraftKey(id))
    if (!text) return null
    const v = JSON.parse(text) as Partial<StoredShipped>
    if (typeof v !== 'object' || v === null || !('override' in v)) return null
    return { from: typeof v.from === 'string' ? v.from : null, override: v.override }
  } catch {
    return null
  }
}

export interface OpenedShipped {
  readonly draft: ShippedDraft
  /**
   * The history's saved part: the text of the override on disk (as the writer
   * would write it), or null for no file, or one with no edit in it.
   */
  readonly saved: string | null
  /** The draft is this browser's unsaved edits over that file, not the file. */
  readonly restored: boolean
  /** Something the author must be told: an unreadable file, a baseline that moved. */
  readonly problems: readonly string[]
}

/**
 * The draft to open mission `base` with. `disk` is `content/overrides/<id>.json`
 * as the dev server serves it now (null: no file); `stored` is this browser's
 * copy. The stored draft wins only when it was made over the file that is on
 * disk now — so unsaved edits survive a reload, and a file changed underneath
 * (a `git checkout`, a hand edit, a save from another tab) is never covered
 * over by an older draft. Either way the override is pinned to `baseSha`, the
 * manifest's line today (§3.3): a stale one is re-pinned, said, and saving it
 * re-pins the file.
 */
export const openShipped = (
  base: Level,
  baseSha: string,
  disk: string | null,
  stored: StoredShipped | null,
): OpenedShipped => {
  const problems: string[] = []
  const read = (raw: unknown, what: string): LevelOverride | null => {
    const checked = validateOverride(raw)
    if (!checked.ok) {
      const [p, m] = checked.errors[0] ?? ['', 'unreadable']
      problems.push(`${what} was refused (${p ? `${p}: ` : ''}${m}); it is not opened`)
      return null
    }
    if (checked.override.mission !== base.id) {
      problems.push(`${what} names ${checked.override.mission}, not ${base.id}; it is not opened`)
      return null
    }
    return checked.override
  }
  let fromDisk: LevelOverride | null = null
  if (disk !== null) {
    try {
      fromDisk = read(JSON.parse(disk), `content/overrides/${base.id}.json`)
    } catch {
      problems.push(`content/overrides/${base.id}.json is not JSON; it is not opened`)
    }
  }
  const local =
    stored && stored.from === disk ? read(stored.override, 'the draft in this browser') : null
  const chosen = local ?? fromDisk
  if (chosen && chosen.base !== baseSha) {
    problems.push(
      `the baseline moved under this override (it pins ${chosen.base.slice(0, 12)}…, the manifest now says ${baseSha.slice(0, 12)}…): check every entity it names, and save to re-pin it`,
    )
  }
  const override: LevelOverride = chosen
    ? { ...chosen, $schema: chosen.$schema ?? './_override.schema.json', base: baseSha }
    : emptyOverride(base, baseSha)
  const draft: ShippedDraft = { base, override, selection: null }
  const restored =
    local !== null && overrideText(local) !== (fromDisk ? overrideText(fromDisk) : null)
  return { draft, saved: fromDisk ? overrideText(fromDisk) : null, restored, problems }
}

// ── Poses ─────────────────────────────────────────────────────────────────

const samePose = (a: OverridePose, b: OverridePose): boolean =>
  a.pos.every((v, i) => v === b.pos[i]) && a.quat.every((v, i) => v === b.quat[i])

const baseRing = (base: Level, key: string): Ring | undefined =>
  base.routes.flatMap((r) => r.rings).find((r) => ringKey(r) === key)
const baseTurn = (base: Level, key: string): TurnIndicator | undefined =>
  base.turnIndicators.find((t) => turnIndicatorKey(t) === key)

/** The pose `e` stands at in `level` (the draft's level, or the baseline), or null where it is not. */
export const entityPose = (level: Level, e: ShippedEntity): OverridePose | null => {
  // A control point is the FILE's, not the level's (whose line is resampled):
  // `shippedPose` reads it off the draft.
  if (e.kind === 'point') return null
  if (e.kind === 'finish') {
    return level.finish ? { pos: level.finish.pos, quat: level.finish.quat } : null
  }
  if (e.kind === 'ring') {
    const r = level.routes.flatMap((x) => x.rings).find((x) => ringKey(x) === e.key)
    return r ? { pos: r.pos, quat: r.quat } : null
  }
  const t = level.turnIndicators.find((x) => turnIndicatorKey(x) === e.key)
  return t ? { pos: t.pos, quat: t.quat } : null
}

// ── Commands ──────────────────────────────────────────────────────────────

/** The override with block `kind` replaced, and dropped when it is left empty. */
const withBlock = (
  ov: LevelOverride,
  kind: 'rings' | 'turnIndicators',
  block: OverrideEntities,
): LevelOverride => {
  const tidy: { move?: Record<string, OverridePose>; remove?: string[]; add?: OverrideAdd[] } = {}
  if (block.move && Object.keys(block.move).length > 0) tidy.move = { ...block.move }
  if (block.remove && block.remove.length > 0) tidy.remove = [...new Set(block.remove)].sort()
  if (block.add && block.add.length > 0) tidy.add = [...block.add]
  const { [kind]: _old, ...rest } = ov
  return Object.keys(tidy).length > 0 ? ({ ...rest, [kind]: tidy } as LevelOverride) : rest
}

const blockOf = (kind: 'ring' | 'turn'): 'rings' | 'turnIndicators' =>
  kind === 'ring' ? 'rings' : 'turnIndicators'

/** Pick `e` (or nothing). Not an edit: the history pushes no entry for it. */
export const selectEntity = (d: ShippedDraft, e: ShippedEntity | null): ShippedDraft =>
  sameEntity(e, d.selection) ? d : { ...d, selection: e }

/**
 * Stand `e` at `pos`, turned to `quat` — a ring rigidly, trigger and all; a
 * turn indicator as its placement; the finish with its frame and studs (the
 * loader's `moveRingRigid` / `moveFinishRigid`). Back on 2016's own pose, the
 * move drops out of the file.
 */
export const moveEntity = (
  d: ShippedDraft,
  e: ShippedEntity,
  pos: readonly number[],
  quat: readonly number[],
): ShippedDraft => {
  if (
    ![...pos, ...quat].every((v) => Number.isFinite(v)) ||
    pos.length !== 3 ||
    quat.length !== 4
  ) {
    return d
  }
  if (e.kind === 'point') return moveLinePoint(d, e.index, pos)
  const to = canonicalPose(pos, quat)
  if (!to) return d
  const ov = d.override
  if (e.kind === 'finish') {
    const f = d.base.finish
    if (f?.shape !== 'sphereUnion') return d
    const home = canonicalPose(f.pos, f.quat)
    if (home && samePose(to, home)) {
      if (!ov.finish) return d
      const { finish: _f, ...rest } = ov
      return { ...d, override: rest }
    }
    if (ov.finish && samePose(ov.finish, to)) return d
    return { ...d, override: { ...ov, finish: to } }
  }
  const kind = blockOf(e.kind)
  const block: OverrideEntities = ov[kind] ?? {}
  if (isAddedKey(e.key)) {
    const add = block.add ?? []
    const i = add.findIndex((a) => a.key === e.key)
    const was = add[i]
    if (!was || samePose(was, to)) return d
    const next = add.map((a, j) => (j === i ? { ...a, pos: to.pos, quat: to.quat } : a))
    return { ...d, override: withBlock(ov, kind, { ...block, add: next }) }
  }
  const home = e.kind === 'ring' ? baseRing(d.base, e.key) : baseTurn(d.base, e.key)
  if (!home || (block.remove ?? []).includes(e.key)) return d
  const move = { ...(block.move ?? {}) }
  const held = move[e.key]
  const homePose = canonicalPose(home.pos, home.quat)
  if (homePose && samePose(to, homePose)) {
    if (!held) return d
    delete move[e.key]
  } else {
    if (held && samePose(held, to)) return d
    move[e.key] = to
  }
  return { ...d, override: withBlock(ov, kind, { ...block, move }) }
}

/** The live rings in the draft's level, or the baseline's when the draft does not apply. */
const ringsNow = (d: ShippedDraft): Ring[] => {
  const t = tryShippedLevel(d)
  return liveRings(t.level ?? d.base)
}

/**
 * Take `e` out of the course: a 2016 ring or turn indicator into the file's
 * `remove` (its move, if any, goes); an added one's `add` entry deleted, and
 * any add that stood after it re-anchored to what it stood after. The finish
 * is not removable, and a ring is not removed below the format's minimum.
 * Selection drops when it was `e`.
 */
export const removeEntity = (d: ShippedDraft, e: ShippedEntity): ShippedDraft => {
  if (e.kind === 'finish') return d
  if (e.kind === 'point') return deleteLinePoint(d, e.index)
  if (e.kind === 'ring' && ringsNow(d).length <= PLAYER_COURSE_LIMITS.rings.min) return d
  const kind = blockOf(e.kind)
  const ov = d.override
  const block: OverrideEntities = ov[kind] ?? {}
  let next: OverrideEntities
  if (isAddedKey(e.key)) {
    const add = block.add ?? []
    const gone = add.find((a) => a.key === e.key)
    if (!gone) return d
    next = {
      ...block,
      add: add
        .filter((a) => a.key !== e.key)
        .map((a) => (a.after === e.key ? { ...a, after: gone.after } : a)),
    }
  } else {
    const home = e.kind === 'ring' ? baseRing(d.base, e.key) : baseTurn(d.base, e.key)
    if (!home || (block.remove ?? []).includes(e.key)) return d
    const move = { ...(block.move ?? {}) }
    delete move[e.key]
    next = { ...block, move, remove: [...(block.remove ?? []), e.key] }
  }
  const selected = d.selection
  const deselect =
    selected !== null && selected.kind === e.kind && 'key' in selected && selected.key === e.key
  return {
    ...d,
    override: withBlock(ov, kind, next),
    selection: deselect ? null : selected,
  }
}

/**
 * A new ring after ring `key`: half way to the ring after it, turned as `key`
 * is (with no ring after, as far past it again as it stands past the one
 * before). A copy of the mission's first live ring, moved there — DEV-466's
 * rule, which `applyOverride` applies. Selected, so the gizmo is on it.
 */
export const addRingAfter = (d: ShippedDraft, key: string): ShippedDraft => {
  const rings = ringsNow(d)
  if (rings.length >= PLAYER_COURSE_LIMITS.rings.max) return d
  const i = rings.findIndex((r) => ringKey(r) === key)
  const here = rings[i]
  if (!here) return d
  const after = rings[i + 1]
  const before = rings[i - 1]
  const at: Vec3Tuple = after
    ? [
        (here.pos[0] + after.pos[0]) / 2,
        (here.pos[1] + after.pos[1]) / 2,
        (here.pos[2] + after.pos[2]) / 2,
      ]
    : before
      ? [
          2 * here.pos[0] - before.pos[0],
          2 * here.pos[1] - before.pos[1],
          2 * here.pos[2] - before.pos[2],
        ]
      : [here.pos[0], here.pos[1], here.pos[2]]
  const block: OverrideEntities = d.override.rings ?? {}
  const pose = canonicalPose(at, here.quat)
  if (!pose) return d
  const add: OverrideAdd = {
    key: nextAddedKey(block.add),
    after: key,
    pos: pose.pos,
    quat: pose.quat,
  }
  return {
    ...d,
    override: withBlock(d.override, 'rings', { ...block, add: [...(block.add ?? []), add] }),
    selection: { kind: 'ring', key: add.key },
  }
}

/** Put `e` back as 2016 shipped it: its move and its removal out of the file (an added one stays). */
export const revertEntity = (d: ShippedDraft, e: ShippedEntity): ShippedDraft => {
  // A control point has no 2016 pose: the line as a whole goes back (`revertLine`).
  if (e.kind === 'point') return d
  if (e.kind === 'finish') {
    if (!d.override.finish) return d
    const { finish: _f, ...rest } = d.override
    return { ...d, override: rest }
  }
  if (isAddedKey(e.key)) return d
  const kind = blockOf(e.kind)
  const block = d.override[kind]
  if (!block || (!block.move?.[e.key] && !(block.remove ?? []).includes(e.key))) return d
  const move = { ...(block.move ?? {}) }
  delete move[e.key]
  return {
    ...d,
    override: withBlock(d.override, kind, {
      ...block,
      move,
      remove: (block.remove ?? []).filter((k) => k !== e.key),
    }),
  }
}

/**
 * The time limit or the par, seconds, on the format's quantum and inside the
 * player course's bounds. Back on 2016's own number, it drops out of the file.
 */
export const setTimer = (
  d: ShippedDraft,
  field: 'timeLimit' | 'bonusParTime',
  seconds: number,
): ShippedDraft => {
  if (!Number.isFinite(seconds)) return d
  const T = PLAYER_COURSE_LIMITS.timeLimitSeconds
  const s = quantise(
    Math.min(T.max, Math.max(T.min, seconds)),
    PLAYER_COURSE_SHAPE.timeLimitQuantumSeconds,
  )
  const timer: { timeLimit?: number; bonusParTime?: number } = { ...(d.override.timer ?? {}) }
  if (s === d.base.timer[field]) {
    if (timer[field] === undefined) return d
    delete timer[field]
  } else {
    if (timer[field] === s) return d
    timer[field] = s
  }
  const { timer: _t, ...rest } = d.override
  return {
    ...d,
    override: Object.keys(timer).length > 0 ? { ...rest, timer } : rest,
  }
}

/** A note on why (§3.6, Matt's call 4: the why of each change beside its numbers). Blank adds nothing. */
export const addNote = (d: ShippedDraft, at: string, what: string): ShippedDraft => {
  const text = what.trim()
  if (text.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(at)) return d
  return {
    ...d,
    override: { ...d.override, notes: [...(d.override.notes ?? []), { at, what: text }] },
  }
}

/** What the file would change: counts per kind, for the panel. */
export const overrideSummary = (
  ov: LevelOverride,
): {
  readonly moved: number
  readonly removed: number
  readonly added: number
  readonly finish: boolean
  readonly timer: boolean
  /** DEV-541: how many control points the file's own line has; 0 is 2016's line. */
  readonly linePoints: number
} => {
  const count = (b: OverrideEntities | undefined) => ({
    moved: Object.keys(b?.move ?? {}).length,
    removed: (b?.remove ?? []).length,
    added: (b?.add ?? []).length,
  })
  const r = count(ov.rings)
  const t = count(ov.turnIndicators)
  return {
    moved: r.moved + t.moved,
    removed: r.removed + t.removed,
    added: r.added + t.added,
    finish: ov.finish !== undefined,
    timer: ov.timer !== undefined,
    linePoints: ov.route?.points.length ?? 0,
  }
}

// ── The line (DEV-541) ────────────────────────────────────────────────────

/** The file's own control points, or null while the mission flies 2016's line. */
export const linePoints = (d: ShippedDraft): readonly Vec3Tuple[] | null =>
  d.override.route?.points ?? null

/**
 * "Edit the line"'s seed: `fitFlight` over 2016's line (`base.route`), as a
 * recorded flight is fitted — at most the format's 64 control points, within
 * `FIT_POLICY.toleranceMetres` of 2016's line both ways, or the least wider
 * tolerance that fits (the fit says which). Null for a mission with no line.
 */
export const seedLine = (base: Level): FlightFit | null =>
  Array.isArray(base.route) && base.route.length > 1 ? fitFlight(base.route) : null

/**
 * The file takes its own line, seeded from 2016's (`seedLine`): one command,
 * so one undo step. A draft that already has one is returned as it is — the
 * seed never overwrites an edited line.
 */
export const editLine = (d: ShippedDraft): ShippedDraft => {
  if (d.override.route) return d
  const fit = seedLine(d.base)
  if (!fit || fit.points.length < PLAYER_COURSE_LIMITS.points.min) return d
  return {
    ...d,
    override: { ...d.override, route: { points: fit.points.map((p) => quantisePos(p)) } },
    selection: null,
  }
}

/** Back to 2016's line: the file's `route` goes (and a picked control point with it). */
export const revertLine = (d: ShippedDraft): ShippedDraft => {
  if (!d.override.route) return d
  const { route: _r, ...rest } = d.override
  return { ...d, override: rest, selection: d.selection?.kind === 'point' ? null : d.selection }
}

const withLine = (
  d: ShippedDraft,
  points: readonly Vec3Tuple[],
  selection: ShippedEntity | null,
): ShippedDraft =>
  routeIssues(points).length === 0
    ? { ...d, override: { ...d.override, route: { points: [...points] } }, selection }
    : d

/**
 * Control point `index` to `pos`, on the format's quantum. Refused (the draft
 * returned as it is) where the validator would refuse the line: nearer a
 * neighbour than the format's least spacing, or out of bounds.
 */
export const moveLinePoint = (
  d: ShippedDraft,
  index: number,
  pos: readonly number[],
): ShippedDraft => {
  const points = linePoints(d)
  const old = points?.[index]
  if (!points || !old || pos.length !== 3 || !pos.every((v) => Number.isFinite(v))) return d
  const to = quantisePos(pos)
  if (to.every((v, i) => v === old[i])) return d
  return withLine(
    d,
    points.map((p, i) => (i === index ? to : p)),
    d.selection,
  )
}

/**
 * A new control point after `index`, ON the curve half way to the next point
 * (the curve's own parameter, so the line hardly moves until it is dragged);
 * after the last, as far past it again as it stands past the one before.
 * Selected. Refused at the format's 64, or where it would stand nearer a
 * neighbour than the least spacing.
 */
export const insertLinePointAfter = (d: ShippedDraft, index: number): ShippedDraft => {
  const points = linePoints(d)
  const here = points?.[index]
  if (!points || !here || points.length >= PLAYER_COURSE_LIMITS.points.max) return d
  const next = points[index + 1]
  let at: Vec3Tuple
  if (next) {
    const div = PLAYER_COURSE_SHAPE.divisionsPerSegment
    const spline = buildCourseSpline(
      points.map(([x, y, z]) => ({ x, y, z })),
      { divisionsPerSegment: div, tension: PLAYER_COURSE_SHAPE.tension },
    )
    // Sample `index * div + div / 2` is at curve parameter `index + ½` exactly.
    const s = spline.samples[index * div + Math.floor(div / 2)]
    if (!s) return d
    at = quantisePos([s.x, s.y, s.z])
  } else {
    const before = points[index - 1]
    if (!before) return d
    at = quantisePos([2 * here[0] - before[0], 2 * here[1] - before[1], 2 * here[2] - before[2]])
  }
  const out = [...points.slice(0, index + 1), at, ...points.slice(index + 1)]
  return withLine(d, out, { kind: 'point', index: index + 1 })
}

/** Control point `index` out of the line; refused below the format's two. The selection drops. */
export const deleteLinePoint = (d: ShippedDraft, index: number): ShippedDraft => {
  const points = linePoints(d)
  if (!points?.[index]) return d
  const out = [...points.slice(0, index), ...points.slice(index + 1)]
  const picked = d.selection?.kind === 'point' && d.selection.index === index
  return withLine(d, out, picked ? null : d.selection)
}

/**
 * Where `e` stands in the draft — {@link entityPose} on the draft's level, and
 * a control point off the file itself (it has no turn: the identity).
 */
export const shippedPose = (
  d: ShippedDraft,
  level: Level | null,
  e: ShippedEntity,
): OverridePose | null => {
  if (e.kind === 'point') {
    const p = linePoints(d)?.[e.index]
    return p ? { pos: p, quat: [0, 0, 0, 1] } : null
  }
  return level ? entityPose(level, e) : null
}

/**
 * "Snap ring to line": ring `key` stood on the nearest point of the line the
 * draft flies (`level.route`, 2016's or the file's), facing along it —
 * `placeRing`'s pose (`ringPoseAlong`: its own facing turned onto the line's
 * direction, up kept up), the trigger carried rigidly. An explicit press: a
 * ring never follows the line on its own (§4.4).
 */
export const snapRingToLine = (d: ShippedDraft, key: string): ShippedDraft => {
  const level = tryShippedLevel(d).level
  if (!level) return d
  const ring = liveRings(level).find((r) => ringKey(r) === key)
  const near = ring ? nearestOnLine(ring.pos, level.route ?? []) : null
  if (!ring || !near) return d
  const pose = ringPoseAlong(ring, near.at, near.along)
  return moveEntity(d, { kind: 'ring', key }, pose.pos, pose.quat)
}

// ── Warnings ──────────────────────────────────────────────────────────────

const round1 = (x: number): string => (Math.round(x * 10) / 10).toFixed(1)

/** Metres from `p` to the polyline `line`, measured to its SEGMENTS, not its vertices (DEV-027). */
export const distanceToLine = (
  p: readonly number[],
  line: readonly (readonly number[])[],
): number => nearestOnLine(p, line)?.metres ?? Number.POSITIVE_INFINITY

/**
 * The point of the polyline `line` nearest `p` — to its SEGMENTS, not its
 * vertices (DEV-027) — the direction of travel there (the segment's, in the
 * line's own order: `level.route` runs start to finish), and how far it is.
 * Null for a line with no segment of any length.
 */
export const nearestOnLine = (
  p: readonly number[],
  line: readonly (readonly number[])[],
): { readonly at: Vec3Tuple; readonly along: Vec3Tuple; readonly metres: number } | null => {
  let best: { at: Vec3Tuple; along: Vec3Tuple; metres: number } | null = null
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as readonly number[]
    const b = line[i] as readonly number[]
    const ab = [
      (b[0] as number) - (a[0] as number),
      (b[1] as number) - (a[1] as number),
      (b[2] as number) - (a[2] as number),
    ] as const
    const ap = [
      (p[0] as number) - (a[0] as number),
      (p[1] as number) - (a[1] as number),
      (p[2] as number) - (a[2] as number),
    ] as const
    const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
    if (!(L > 0)) continue
    const u = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L))
    const metres = Math.hypot(ap[0] - u * ab[0], ap[1] - u * ab[1], ap[2] - u * ab[2])
    if (best === null || metres < best.metres) {
      const n = Math.sqrt(L)
      best = {
        at: [
          (a[0] as number) + u * ab[0],
          (a[1] as number) + u * ab[1],
          (a[2] as number) + u * ab[2],
        ],
        along: [ab[0] / n, ab[1] / n, ab[2] / n],
        metres,
      }
    }
  }
  return best
}

export interface ShippedEvaluation {
  /** The level as it will load, or null when the override is refused. */
  readonly level: Level | null
  /** Errors first, then warnings. */
  readonly warnings: readonly EditorWarning[]
}

/**
 * What is wrong with the draft, live:
 *
 *   invalid         the loader refuses the override (`applyOverride`'s own
 *                   message). An ERROR: there is no level to draw, fly or save.
 *   ring-off-line   a ring whose trigger centre is further from the racing line
 *                   (`level.route`, to its segments) than the trigger's own
 *                   radius. The AI racers fly the line, not ring to ring
 *                   (§6.3): they pass its place on the line and turn back for
 *                   it (DEV-541 measured it; the racer proof,
 *                   `override-racers.test.ts`, is the gate, and catches a
 *                   turn-back this threshold misses). On every one of 2016's seven
 *                   HoverJet missions every trigger is within 1.5 m of the line
 *                   against a 22.6 m radius, so the warning is silent until an
 *                   edit moves a ring off it (`editor-shipped.test.ts`).
 *   ring-in-ground  the ground, plus the HoverJet's clearance, reaches into the
 *                   opening of a ring the OVERRIDE placed (moved or added) —
 *                   `ringIntrusion`, the player course's rule. 2016's own
 *                   placements are not judged: they are the baseline.
 *
 * Both of the last are WARNINGS: on a shipped mission the author is the
 * creative director, and nothing he places is refused but by the validator.
 */
export const evaluateShipped = (d: ShippedDraft, ground: Ground | null): ShippedEvaluation => {
  const t = tryShippedLevel(d)
  if (!t.level) {
    return {
      level: null,
      warnings: [{ kind: 'invalid', severity: 'error', message: t.error, at: null }],
    }
  }
  const level = t.level
  const warnings: EditorWarning[] = []
  const route = level.route ?? []
  const rings = liveRings(level)
  rings.forEach((ring, i) => {
    if (route.length >= 2) {
      const off = distanceToLine(ring.trigger.pos, route)
      if (off > ring.trigger.radius) {
        warnings.push({
          kind: 'ring-off-line',
          severity: 'warning',
          message:
            `Ring ${i + 1} is ${round1(off)} m off the racing line, past its ${round1(ring.trigger.radius)} m trigger: ` +
            'the AI racers fly the line, and will turn back for it.',
          at: [ring.pos[0], ring.pos[1], ring.pos[2]],
          ring: i,
          metres: off,
        })
      }
    }
    const meta = (ring as Ring & { _meta?: Record<string, unknown> })._meta
    const placed = meta?.movedBy === 'override' || typeof meta?.overrideKey === 'string'
    if (ground && placed) {
      const hit = ringIntrusion(
        { trigger: ring.trigger, quat: ring.quat },
        ground,
        groundClearance(),
      )
      if (hit) {
        warnings.push({
          kind: 'ring-in-ground',
          severity: 'warning',
          message: `Ring ${i + 1} is ${round1(hit.metres)} m into the ground (with the jet's clearance).`,
          at: hit.at,
          ring: i,
          metres: hit.metres,
        })
      }
    }
  })
  return { level, warnings }
}

/** The entity a live ring of the draft's level answers to, by its index among the live rings. */
export const ringEntityAt = (level: Level, i: number): ShippedEntity | null => {
  const key = ringKey(liveRings(level)[i] as Ring)
  return key ? { kind: 'ring', key } : null
}

/** The live turn indicators of `level`, with their keys. */
export const liveTurnIndicators = (level: Level): { key: string; t: TurnIndicator }[] =>
  level.turnIndicators
    .filter((t) => t.live)
    .map((t) => ({ key: turnIndicatorKey(t) ?? '', t }))
    .filter((x) => x.key !== '')

/** Has the override moved, removed or added `e`? For the panel's word and the handle's colour. */
export const entityState = (
  d: ShippedDraft,
  e: ShippedEntity,
): '2016' | 'moved' | 'added' | 'removed' => {
  // Every control point is the author's: 2016's line has none (it is 400-odd samples).
  if (e.kind === 'point') return 'moved'
  if (e.kind === 'finish') return d.override.finish ? 'moved' : '2016'
  if (isAddedKey(e.key)) return 'added'
  const block = d.override[blockOf(e.kind)]
  if ((block?.remove ?? []).includes(e.key)) return 'removed'
  return block?.move?.[e.key] ? 'moved' : '2016'
}
