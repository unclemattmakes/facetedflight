// src/editor/desk/shipped.ts — the editor, opened on a SHIPPED mission.
// DEV-540 (docs/plan/SHIPPED-COURSE-EDITS.md §4).
//
// Matt, 2026-09-29: *"i have no other way of iterating those levels based on
// feedback"*. This is the door: `pnpm dev`, then `?edit=1&shipped=<id>` (or
// the player desk's "Shipped missions (dev)" list). It opens 2016's mission as
// 2016 shipped it plus whatever `content/overrides/<id>.json` already says,
// and lets him:
//
//   · pick a ring, a turn indicator or the finish (a click on its handle) and
//     move it with the gizmo's arrows, or turn it (R) — a ring rigidly,
//     trigger and all, as the loader moves it;
//   · remove a ring or a turn indicator, add a ring after the picked one, put
//     one back as 2016 had it;
//   · set the time limit and the par;
//   · SAVE: the override, in the writer's own bytes, `PUT` to the dev server
//     (DEV-539), which writes `content/overrides/<id>.json`. Git is the review;
//   · FLY the course as it stands, and FLY 2016's, for the A/B in one session.
//
// ── Dev only, and absent from every build ────────────────────────────────
//
// A player has no repo to write to, and a list offering the thirteen missions
// as editable would invite remixes of 2016's courses (§4.3). `boot/app.ts`
// reaches this module ONLY through `import('@/editor/desk/shipped')` inside an
// `import.meta.env.DEV` branch, which a production build folds to false and
// drops, chunk and all. `tests/unit/editor-shipped-door.test.ts` holds app.ts
// and the desk to that shape, and DEVIATIONS DEV-540 records the check on
// `dist/`.
//
// ── What it is NOT ───────────────────────────────────────────────────────
//
// It does not turn the mission into a player course (a refit moves rings up to
// 8.5 m, §4.1). A ring moved off the line says so (`ring-off-line`): the AI
// racers fly the line.
//
// ── The line (DEV-541) ───────────────────────────────────────────────────
//
// **Edit the line** gives the file its own racing line, seeded by `fitFlight`
// over 2016's (the core's `editLine`): a violet handle per control point,
// dragged like a ring, **Add point after** and Delete to shape it, **2016's
// line** to put 2016's back. **Snap to line** stands the picked ring on the
// line the course flies, facing along it (`snapRingToLine`). Whether the racers
// then take every ring is `tests/unit/override-racers.test.ts`'s proof, which
// runs over every file Save writes.

import * as THREE from 'three'
import { manifestShaOf, ringKey } from '@/content/level-override'
import { type Level, liveRings, type Vec3Tuple } from '@/content/level-schema'
import { loadBaselineLevel } from '@/content/load-level'
import { PLAYER_COURSE_LIMITS, playerCourseArea } from '@/content/player-course'
import {
  addNote,
  addRingAfter,
  canRedo,
  canUndo,
  createDebounce,
  createHistory,
  createHistoryLoop,
  type DraftStorage,
  editLine,
  emptyOverride,
  entityPose,
  entityState,
  evaluateShipped,
  type Ground,
  type History,
  insertLinePointAfter,
  isDirty,
  isShippedEditable,
  linePoints,
  liveTurnIndicators,
  loadShippedDraft,
  markSaved,
  moveEntity,
  NO_GROUND,
  openShipped,
  overrideSummary,
  overrideText,
  type PlaytestResult,
  redo,
  removeEntity,
  revertEntity,
  revertLine,
  SHIPPED_DRAFT_KIND,
  type ShippedDraft,
  type ShippedEntity,
  type ShippedEvaluation,
  sameEntity,
  saveShippedDraft,
  seal,
  seedLine,
  selectEntity,
  setTimer,
  shippedPose,
  snapRingToLine,
  undo,
} from '@/editor/core'
import { make } from '@/editor/ui/dom'
import { safeLocalStorage } from '@/game/storage'
import { type LoadedTurnIndicators, loadTurnIndicators } from '@/game/turn-indicators'
import { isolateTextEntryKeys } from '@/input/text-entry'
import { sha256HexAsync } from '@/net/digest'
import { createDeskCamera } from './camera'
import { createDeskGizmo, ringGeometryOf } from './gizmo'
import { deskGround } from './ground'
import type { Desk, DeskDebug, DeskHost } from './host'
import { PANEL_STYLE } from './panel'
import { deskKeyAction, nearestWithin, type ScreenPoint } from './pick'
import { DESK_POLICY } from './policy'
import { createDeskView } from './view'

/** The dev server's write (DEV-539, `tools/dev/override-writer.mjs`). */
const OVERRIDE_ROUTE = '/__ff2/override/'

/** Draw order for the handles: over the world and the game's rings. */
const OVERLAY_ORDER = 1000

const COLOURS = {
  line: 0xffffff,
  ring: 0xe8f4ff,
  moved: 0xffa726,
  added: 0x33e07a,
  removed: 0x8a8f98,
  turn: 0x5ab4ff,
  finish: 0xffffff,
  selected: 0xffc233,
  /** DEV-541: a control point of the file's own line. */
  point: 0xc27bff,
} as const

/** DEV-541: a control point's handle beside a ring's, which is 1. */
const POINT_HANDLE_SCALE = 0.6

/**
 * A text file as `pnpm dev` serves it from the repo, or null when there is
 * none. `Accept` names no HTML, so Vite's SPA fallback answers a missing file
 * with a 404 rather than with `index.html`.
 */
const fetchText = async (url: string): Promise<string | null> => {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json, text/plain' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  if ((res.headers.get('content-type') ?? '').includes('text/html')) return null
  return res.text()
}

const sha256Hex = async (text: string): Promise<string | null> =>
  // A page over plain HTTP (the browser-pane recipe) has no `crypto.subtle`.
  globalThis.crypto?.subtle ? sha256HexAsync(text) : null

/** Today, `YYYY-MM-DD`, local: a note's date. */
const today = (): string => {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** This page's URL with the editor on `shipped` (or, null, on the player's own courses). */
export const shippedUrl = (id: string | null, href: string = location.href): string => {
  const url = new URL(href)
  url.searchParams.set('edit', '1')
  if (id === null) url.searchParams.delete('shipped')
  else url.searchParams.set('shipped', id)
  return url.toString()
}

const entityName = (level: Level | null, base: Level, e: ShippedEntity): string => {
  if (e.kind === 'finish') return 'The finish'
  if (e.kind === 'point') return `Line point ${e.index + 1}`
  if (e.kind === 'turn') {
    const i = liveTurnIndicators(level ?? base).findIndex((x) => x.key === e.key)
    return i >= 0 ? `Turn indicator ${i + 1}` : 'A removed turn indicator'
  }
  const i = level ? liveRings(level).findIndex((r) => ringKey(r) === e.key) : -1
  return i >= 0 ? `Ring ${i + 1}` : 'A removed ring'
}

/** One handle drawn and pickable: an entity, where it stands, and how it has been edited. */
interface Handle {
  readonly entity: ShippedEntity
  readonly at: Vec3Tuple
  readonly state: '2016' | 'moved' | 'added' | 'removed'
}

/**
 * Open mission `id` in the shipped desk: its baseline, the manifest's pin, the
 * file on disk and this browser's draft, read before the desk stands (the
 * game waits on the promise, behind the loading scene).
 */
export const openShippedDesk = async (host: DeskHost, id: string): Promise<Desk> => {
  const base = await loadBaselineLevel(id)
  if (!isShippedEditable(base)) {
    throw new Error(
      `${id} is not a HoverJet ring course; the shipped door opens those only (DEV-540)`,
    )
  }
  const manifest = await fetchText('/content/_generated.sha256')
  const baseSha = manifest ? manifestShaOf(manifest, id) : null
  if (!baseSha) {
    throw new Error(
      `content/_generated.sha256 lists no content/levels/${id}.json (is this pnpm dev?)`,
    )
  }
  const disk = await fetchText(`/content/overrides/${id}.json`)
  const storage = safeLocalStorage()
  const opened = openShipped(base, baseSha, disk, loadShippedDraft(storage, id))
  return createShippedDesk(host, {
    base,
    opened,
    disk,
    storage,
  })
}

interface ShippedDeskInput {
  readonly base: Level
  readonly opened: ReturnType<typeof openShipped>
  /** The file's text as served when the desk opened; the stored draft's `from`. */
  readonly disk: string | null
  readonly storage: DraftStorage | null
}

const createShippedDesk = (host: DeskHost, input: ShippedDeskInput): Desk => {
  const { base, storage } = input
  const id = base.id
  let history: History<ShippedDraft> = {
    ...createHistory(input.opened.draft, SHIPPED_DRAFT_KIND),
    saved: input.opened.saved,
  }
  /** The file on disk as this desk last knew it: what the stored draft was made over. */
  let diskFrom: string | null = input.disk
  let problems: readonly string[] = input.opened.problems
  const draft = (): ShippedDraft => history.present

  let active = true
  let busy = false
  let dragging = false
  let rotating = false
  let ground: Ground = NO_GROUND
  let groundOf: unknown = null
  let evaluation: ShippedEvaluation = evaluateShipped(draft(), null)
  let status = input.opened.restored
    ? 'Your unsaved changes from last time, over the file on disk.'
    : input.disk === null
      ? 'As 2016 shipped it: no override on disk.'
      : `Opened content/overrides/${id}.json.`
  let lastSave: {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly unchanged: boolean
    readonly checked: boolean | null
  } | null = null
  let saveError = ''
  let lastFlight: {
    readonly which: 'draft' | '2016'
    readonly rings: number
    readonly finished: boolean
    readonly seconds: number | null
  } | null = null
  let flying: 'draft' | '2016' | null = null
  let noteText = ''

  const cam = createDeskCamera(host.gameCamera, host.canvas, {
    surfaceAt: (x, z) => ground.surfaceAt(x, z),
    blocked: () => dragging,
  })
  const view = createDeskView()

  // ── the overlay: the racing line and a handle per entity ─────────────────
  const overlay = new THREE.Group()
  overlay.name = 'editor-shipped'
  view.root.add(overlay)
  const lineMaterial = new THREE.LineBasicMaterial({
    color: COLOURS.line,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.6,
    fog: false,
  })
  const routeLine = new THREE.Line(new THREE.BufferGeometry(), lineMaterial)
  routeLine.name = 'editor-shipped-line'
  routeLine.renderOrder = OVERLAY_ORDER
  routeLine.frustumCulled = false
  overlay.add(routeLine)
  const handleGroup = new THREE.Group()
  handleGroup.name = 'editor-shipped-handles'
  overlay.add(handleGroup)
  const ballGeometry = new THREE.SphereGeometry(1, 16, 12)
  const diamondGeometry = new THREE.OctahedronGeometry(1, 0)
  const material = (color: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, fog: false })
  const materials = {
    '2016': material(COLOURS.ring),
    moved: material(COLOURS.moved),
    added: material(COLOURS.added),
    removed: material(COLOURS.removed),
    turn: material(COLOURS.turn),
    finish: material(COLOURS.finish),
    selected: material(COLOURS.selected),
    point: material(COLOURS.point),
  }
  const relative = new WeakMap<THREE.Object3D, number>()
  let handles: Handle[] = []

  /** The handles for the draft as it stands: every live ring, turn indicator, the finish, and what was removed. */
  const handlesOf = (level: Level | null): Handle[] => {
    const d = draft()
    const out: Handle[] = []
    const shown = level ?? base
    for (const r of liveRings(shown)) {
      const key = ringKey(r)
      if (!key) continue
      const entity: ShippedEntity = { kind: 'ring', key }
      out.push({ entity, at: [r.pos[0], r.pos[1], r.pos[2]], state: entityState(d, entity) })
    }
    for (const key of d.override.rings?.remove ?? []) {
      const e: ShippedEntity = { kind: 'ring', key }
      const p = entityPose(base, e)
      if (p) out.push({ entity: e, at: [p.pos[0], p.pos[1], p.pos[2]], state: 'removed' })
    }
    for (const { key, t } of liveTurnIndicators(shown)) {
      const entity: ShippedEntity = { kind: 'turn', key }
      out.push({ entity, at: [t.pos[0], t.pos[1], t.pos[2]], state: entityState(d, entity) })
    }
    for (const key of d.override.turnIndicators?.remove ?? []) {
      const e: ShippedEntity = { kind: 'turn', key }
      const p = entityPose(base, e)
      if (p) out.push({ entity: e, at: [p.pos[0], p.pos[1], p.pos[2]], state: 'removed' })
    }
    if (shown.finish) {
      const f = shown.finish.pos
      out.push({
        entity: { kind: 'finish' },
        at: [f[0], f[1], f[2]],
        state: entityState(d, { kind: 'finish' }),
      })
    }
    // DEV-541: the file's own line, a handle per control point.
    for (const [index, p] of (linePoints(d) ?? []).entries()) {
      out.push({ entity: { kind: 'point', index }, at: [p[0], p[1], p[2]], state: 'moved' })
    }
    return out
  }

  const drawOverlay = (): void => {
    const level = evaluation.level
    const route = (level ?? base).route ?? []
    const flat = new Float32Array(route.length * 3)
    route.forEach((p, i) => {
      flat.set([p[0], p[1], p[2]], i * 3)
    })
    routeLine.geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3))
    routeLine.geometry.setDrawRange(0, route.length)
    handles = handlesOf(level)
    handleGroup.clear()
    const sel = draft().selection
    for (const h of handles) {
      const picked = sameEntity(h.entity, sel)
      const m = new THREE.Mesh(
        h.entity.kind === 'ring' || h.entity.kind === 'point' ? ballGeometry : diamondGeometry,
        picked
          ? materials.selected
          : h.entity.kind === 'point'
            ? materials.point
            : h.state === 'removed'
              ? materials.removed
              : h.entity.kind === 'turn' && h.state === '2016'
                ? materials.turn
                : h.entity.kind === 'finish' && h.state === '2016'
                  ? materials.finish
                  : materials[h.state],
      )
      m.name = `editor-shipped-${h.entity.kind}`
      m.position.set(h.at[0], h.at[1], h.at[2])
      m.renderOrder = OVERLAY_ORDER + 1
      m.frustumCulled = false
      relative.set(
        m,
        (h.entity.kind === 'finish' ? 1.6 : h.entity.kind === 'point' ? POINT_HANDLE_SCALE : 1) *
          (picked ? 1.3 : 1),
      )
      handleGroup.add(m)
    }
  }

  // ── the turn indicators, drawn as the game draws them ────────────────────
  let turns: LoadedTurnIndicators | null = null
  let turnsGeneration = 0
  const setTurns = (level: Level | null): void => {
    const generation = ++turnsGeneration
    if (!level) return
    void loadTurnIndicators(level).then(
      (loaded) => {
        if (generation !== turnsGeneration) {
          loaded.dispose()
          return
        }
        turns?.object.removeFromParent()
        turns?.dispose()
        turns = loaded
        loaded.object.name = 'editor-shipped-turn-indicators'
        view.root.add(loaded.object)
      },
      (err: unknown) => console.warn('editor: the turn indicators did not build', err),
    )
  }

  // ── the gizmo ─────────────────────────────────────────────────────────────
  const {
    proxy,
    gizmo,
    debugHooks: gizmoDebug,
  } = createDeskGizmo(cam.camera, host.canvas, view.root)
  gizmo.addEventListener('dragging-changed', (e) => {
    dragging = e.value === true
    cam.controls.enabled = !dragging
    if (!dragging) {
      history = seal(history)
      changed()
    }
  })
  gizmo.addEventListener('objectChange', () => {
    if (!dragging) return
    const sel = draft().selection
    if (!sel) return
    const p = proxy.position
    const q = proxy.quaternion
    const key = `move:${sel.kind}:${
      sel.kind === 'finish' ? '' : sel.kind === 'point' ? sel.index : sel.key
    }`
    apply(moveEntity(draft(), sel, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]), key)
  })

  const syncGizmo = (): void => {
    const sel = draft().selection
    const pose = sel ? shippedPose(draft(), evaluation.level, sel) : null
    if (!sel || !pose) {
      gizmo.detach()
      return
    }
    if (!dragging) {
      proxy.position.set(pose.pos[0], pose.pos[1], pose.pos[2])
      proxy.quaternion.set(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3])
    }
    // A control point has no turn: its arrows only ever move it.
    gizmo.setMode(rotating && sel.kind !== 'point' ? 'rotate' : 'translate')
    if (gizmo.object !== proxy) gizmo.attach(proxy)
  }

  // ── the loop of an edit ───────────────────────────────────────────────────
  const { edit: apply, step } = createHistoryLoop<ShippedDraft>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => changed(),
    canEdit: () => !busy,
    canStep: () => !busy && !dragging,
  })
  const autosave = createDebounce(
    () => saveShippedDraft(storage, draft(), diskFrom),
    DESK_POLICY.autosaveMs,
  )
  const saveNow = (): void => autosave.flush()

  /** The level the next ring rebuild draws: the last one `evaluate` judged. */
  let pendingRingLevel: Level | null = null
  const ringRebuild = createDebounce(() => {
    view.setLevel(pendingRingLevel)
    setTurns(pendingRingLevel)
  }, DESK_POLICY.ringRebuildMs)
  const evaluate = (): void => {
    evaluation = evaluateShipped(draft(), ground === NO_GROUND ? null : ground)
    view.setWarnings(evaluation.warnings)
    pendingRingLevel = evaluation.level
    ringRebuild.schedule()
  }

  const changed = (): void => {
    evaluate()
    drawOverlay()
    syncGizmo()
    autosave.schedule()
    renderPanel()
  }

  const syncGround = (): boolean => {
    const t = host.terrains()
    const key = t?.land ?? null
    if (key === groundOf) return false
    groundOf = key
    ground = t ? deskGround(t, null) : NO_GROUND
    return true
  }

  // ── actions ───────────────────────────────────────────────────────────────
  const selected = (): ShippedEntity | null => draft().selection
  const removeSelected = (): void => {
    const sel = selected()
    if (sel) apply(removeEntity(draft(), sel))
  }
  const addAfterSelected = (): void => {
    const sel = selected()
    if (sel?.kind === 'ring') apply(addRingAfter(draft(), sel.key))
  }
  const revertSelected = (): void => {
    const sel = selected()
    if (sel) apply(revertEntity(draft(), sel))
  }
  const toggleRotate = (): void => {
    rotating = !rotating
    changed()
  }
  // ── DEV-541: the line ────────────────────────────────────────────────────
  const editTheLine = (): void => {
    const fit = seedLine(base)
    const before = history
    apply(editLine(draft()))
    if (history !== before && fit) {
      status =
        `The line is yours: ${fit.points.length} control points, within ${fit.error.toFixed(1)} m of 2016’s. ` +
        'Drag a violet point to reshape it; Snap to line puts a ring back on it.'
      renderPanel()
    }
  }
  const lineBack2016 = (): void => {
    apply(revertLine(draft()))
  }
  const snapSelected = (): void => {
    const sel = selected()
    if (sel?.kind === 'ring') apply(snapRingToLine(draft(), sel.key))
  }
  const addPointAfterSelected = (): void => {
    const sel = selected()
    if (sel?.kind === 'point') apply(insertLinePointAfter(draft(), sel.index))
  }

  const save = async (): Promise<void> => {
    if (busy || dragging || !evaluation.level) return
    const note = noteText.trim()
    if (note) apply(addNote(draft(), today(), note))
    const text = overrideText(draft().override)
    if (text === null) {
      status = 'Nothing to save: the course is as 2016 shipped it.'
      renderPanel()
      return
    }
    status = 'Saving…'
    saveError = ''
    renderPanel()
    try {
      const res = await fetch(`${OVERRIDE_ROUTE}${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      })
      const body = (await res.json().catch(() => ({}))) as {
        path?: string
        sha256?: string
        bytes?: number
        unchanged?: boolean
        /** DEV-544: the lap server's courses, rebuilt in the same write when the Save moved them. */
        lapCourses?: { path?: string; changed?: boolean }
        error?: string
        errors?: readonly (readonly [string, string])[]
      }
      if (!res.ok || typeof body.sha256 !== 'string') {
        const first = body.errors?.[0]
        saveError = `Save refused (HTTP ${res.status}): ${body.error ?? 'no reason given'}${
          first ? ` — ${first[0]}: ${first[1]}` : ''
        }`
        status = saveError
        console.warn(`editor: ${saveError}`)
        renderPanel()
        return
      }
      // The writer's bytes are the draft's own text: check it, where the page can.
      const mine = await sha256Hex(text)
      lastSave = {
        path: body.path ?? `content/overrides/${id}.json`,
        sha256: body.sha256,
        bytes: body.bytes ?? text.length,
        unchanged: body.unchanged === true,
        checked: mine === null ? null : mine === body.sha256,
      }
      if (lastSave.checked === false) {
        console.warn(`editor: the file written is not the text sent (${mine} vs ${body.sha256})`)
      }
      history = markSaved(history)
      diskFrom = text
      noteText = ''
      problems = []
      saveNow()
      status = `${lastSave.unchanged ? 'Already saved' : 'Saved'} ${lastSave.path}${lapCoursesNote(body.lapCourses)} · ${lastSave.sha256.slice(0, 12)}… · git diff shows it.`
      document.body.dataset.editorShippedSaved = lastSave.sha256
      console.info(`editor: ${status} (DEV-540)`)
      renderPanel()
    } catch (err) {
      saveError = `Save failed: ${err instanceof Error ? err.message : String(err)} (is this pnpm dev?)`
      status = saveError
      console.warn(`editor: ${saveError}`)
      renderPanel()
    }
  }

  /**
   * "Back to 2016": the draft emptied (one undo step, so an undo brings the
   * edits back to save again) and the file DELETED through the dev server's
   * write, which swallows its own delete as it swallows its own writes — no
   * page on the server reloads. With no file on disk, only the draft empties.
   */
  /**
   * DEV-544: the dev server rebuilds `content/lap-courses.json` in the same
   * write when a Save or Back to 2016 moves the course; the status says so,
   * since that file is in the diff too.
   */
  const lapCoursesNote = (laps: { path?: string; changed?: boolean } | undefined): string =>
    laps?.changed === true ? ` and ${laps.path ?? 'content/lap-courses.json'}` : ''

  const backTo2016 = async (): Promise<void> => {
    if (busy || dragging) return
    apply({ ...draft(), override: emptyOverride(base, draft().override.base), selection: null })
    if (diskFrom === null) {
      history = markSaved(history)
      status = 'Back to 2016: no file on disk, nothing to delete.'
      renderPanel()
      return
    }
    status = 'Deleting…'
    saveError = ''
    renderPanel()
    try {
      const res = await fetch(`${OVERRIDE_ROUTE}${encodeURIComponent(id)}`, { method: 'DELETE' })
      const body = (await res.json().catch(() => ({}))) as {
        path?: string
        lapCourses?: { path?: string; changed?: boolean }
        error?: string
      }
      if (!res.ok) {
        saveError = `Delete refused (HTTP ${res.status}): ${body.error ?? 'no reason given'}`
        status = saveError
        console.warn(`editor: ${saveError}`)
        renderPanel()
        return
      }
      diskFrom = null
      lastSave = null
      history = markSaved(history)
      saveNow()
      status = `Deleted ${body.path ?? `content/overrides/${id}.json`}${lapCoursesNote(body.lapCourses)}: the mission loads as 2016 shipped it. Undo brings your edits back.`
      document.body.dataset.editorShippedSaved = 'deleted'
      console.info(`editor: ${status} (DEV-540)`)
      renderPanel()
    } catch (err) {
      saveError = `Delete failed: ${err instanceof Error ? err.message : String(err)} (is this pnpm dev?)`
      status = saveError
      renderPanel()
    }
  }

  const fly = (which: 'draft' | '2016'): void => {
    if (busy || dragging) return
    const level = which === '2016' ? base : evaluation.level
    if (!level) return
    saveNow()
    busy = true
    flying = which
    renderPanel()
    host.fly({
      course: null,
      courseId: which === '2016' ? `${id}:2016` : `${id}:${level.courseKey ?? '2016'}`,
      fromT: null,
      level,
    })
  }

  // ── the panel ─────────────────────────────────────────────────────────────
  const style = document.createElement('style')
  style.textContent = PANEL_STYLE
  document.head.appendChild(style)
  const el = document.createElement('aside')
  el.id = 'editor-panel'
  el.dataset.editorKind = 'shipped'
  isolateTextEntryKeys(el)
  const button = (name: string, label: string, title: string, onClick: () => void, cls = '') => {
    const b = make('button', { type: 'button', textContent: label, className: cls, title })
    b.dataset.editor = name
    b.addEventListener('click', onClick)
    return b
  }
  const T = PLAYER_COURSE_LIMITS.timeLimitSeconds
  const secondsField = (name: string, title: string, field: 'timeLimit' | 'bonusParTime') => {
    const input = make('input', {
      type: 'number',
      step: '1',
      title,
      min: String(T.min),
      max: String(T.max),
    })
    input.dataset.editor = name
    input.addEventListener('change', () => {
      const v = Number.parseFloat(input.value)
      if (Number.isFinite(v)) apply(setTimer(draft(), field, v))
      renderPanel()
    })
    return input
  }
  const titleEl = make('div', { className: 'name' })
  const factsEl = make('div', { className: 'facts' })
  factsEl.dataset.editor = 'shipped-facts'
  const statusEl = make('div', { className: 'readout' })
  statusEl.dataset.editor = 'shipped-status'
  const problemsEl = make('div', { className: 'refusal' })
  problemsEl.dataset.editor = 'shipped-problems'
  const selectionEl = make('div', { className: 'readout' })
  selectionEl.dataset.editor = 'shipped-selection'
  const rotateB = button(
    'shipped-rotate',
    'Turn (E)',
    'Switch the arrows between moving the picked thing (W) and turning it (E).',
    toggleRotate,
  )
  const addB = button(
    'shipped-add-ring',
    'Add ring after',
    'A new ring half way to the next one, facing as this one does. One undo step.',
    addAfterSelected,
  )
  const removeB = button(
    'shipped-remove',
    'Remove',
    'Take the picked ring or turn indicator out of the course (Delete). It stays drawn grey, to put back.',
    removeSelected,
  )
  const revertB = button(
    'shipped-revert',
    'Put back as 2016',
    'Undo every change to the picked thing: back where 2016 put it.',
    revertSelected,
  )
  const timeIn = secondsField('shipped-time-limit', 'Seconds a player has to finish.', 'timeLimit')
  const parIn = secondsField('shipped-par', 'The time bonus par, seconds.', 'bonusParTime')
  const noteIn = make('input', {
    type: 'text',
    placeholder: 'why (saved in the file’s notes)',
    title:
      'What changed and why: written into the override’s notes, beside the numbers, when you Save.',
  })
  noteIn.dataset.editor = 'shipped-note'
  noteIn.style.cssText =
    'flex:1;background:#0c1520;color:#e8f0f8;border:1px solid #33475c;border-radius:5px;padding:4px 6px;font:inherit'
  noteIn.addEventListener('input', () => {
    noteText = noteIn.value
  })
  const undoB = button('shipped-undo', 'Undo', 'Undo the last change (Ctrl+Z).', () => step(undo))
  const redoB = button('shipped-redo', 'Redo', 'Redo (Ctrl+Y).', () => step(redo))
  const saveB = button(
    'shipped-save',
    'Save',
    `Write content/overrides/${id}.json through the dev server. Review it with git diff; nothing is committed.`,
    () => void save(),
    'primary',
  )
  const flyB = button('shipped-fly', 'Fly', 'Fly the course as it stands now, saved or not.', () =>
    fly('draft'),
  )
  const fly2016B = button(
    'shipped-fly-2016',
    'Fly 2016’s',
    'Fly the mission exactly as 2016 shipped it, for the A/B.',
    () => fly('2016'),
  )
  const topB = button('shipped-top-down', 'Top-down', 'Look straight down (T).', () => {
    cam.setTopDown(!cam.topDown)
    renderPanel()
  })
  const frameB = button(
    'shipped-frame',
    'Frame',
    'Frame the picked thing, or the whole island (F).',
    () => frame(),
  )
  const back2016B = button(
    'shipped-back-2016',
    'Back to 2016',
    `Delete content/overrides/${id}.json: the mission loads as 2016 shipped it. Undo brings your edits back to save again.`,
    () => void backTo2016(),
  )
  const coursesB = button(
    'shipped-courses',
    // DEV-558: Matt, 2026-10-01, *"change "your courses" to "custom courses""*.
    'Custom courses',
    'Back to the course editor, on your own courses.',
    () => {
      saveNow()
      location.assign(shippedUrl(null))
    },
  )
  const leaveB = button(
    'shipped-leave',
    'Leave editor',
    'Out to the hangar. The draft is kept.',
    () => {
      saveNow()
      host.leave()
    },
  )
  const editLineB = button(
    'shipped-edit-line',
    'Edit the line',
    'Give this mission its own racing line, fitted to 2016’s (at most 64 points). The AI racers fly the line. One undo step.',
    editTheLine,
  )
  const line2016B = button(
    'shipped-line-2016',
    '2016’s line',
    'Put 2016’s racing line back: the file’s own line goes.',
    lineBack2016,
  )
  const snapB = button(
    'shipped-snap',
    'Snap to line',
    'Stand the picked ring on the nearest point of the racing line, facing along it.',
    snapSelected,
  )
  const addPointB = button(
    'shipped-add-point',
    'Add point after',
    'A new line point on the curve, half way to the next one. Delete removes a point.',
    addPointAfterSelected,
  )
  const warningList = make('ul', { className: 'warnings' })
  warningList.dataset.editor = 'shipped-warnings'
  el.append(
    make('h2', { textContent: 'SHIPPED MISSION · DEV ONLY' }),
    titleEl,
    factsEl,
    statusEl,
    problemsEl,
    make(
      'div',
      { className: 'group' },
      make('div', { className: 'head', textContent: 'Picked' }),
      selectionEl,
    ),
    make('div', { className: 'buttons' }, rotateB, addB, removeB, revertB),
    make('div', { className: 'buttons' }, editLineB, line2016B, snapB, addPointB),
    make('div', { className: 'sentence' }, 'Time limit', timeIn, 's · par', parIn, 's'),
    make('div', { className: 'row' }, noteIn),
    make('div', { className: 'buttons' }, undoB, redoB, saveB, back2016B),
    make('div', { className: 'buttons' }, flyB, fly2016B),
    make('div', { className: 'buttons' }, topB, frameB),
    warningList,
    make('div', { className: 'buttons' }, coursesB, leaveB),
    make('div', {
      className: 'help',
      textContent:
        'Click a handle to pick it: white a ring as 2016 put it, orange moved, green added, grey removed, ' +
        'blue a turn indicator, the diamond the finish · drag its arrows to move it, R to turn it · ' +
        'Delete removes · Ctrl+Z / Ctrl+Y · Edit the line: violet points shape the racing line the AI flies, ' +
        'Snap to line stands the picked ring on it',
    }),
    make('div', {
      className: 'help',
      textContent:
        'Camera: drag or Alt+drag to orbit · Shift+drag or middle-drag to pan · wheel to zoom · ' +
        'hold right to fly (WASD, Q/E) · F frames · T top-down',
    }),
  )
  document.body.appendChild(el)

  const renderPanel = (): void => {
    const d = draft()
    const level = evaluation.level
    titleEl.textContent = `${base.title} · ${id}`
    const s = overrideSummary(d.override)
    factsEl.textContent =
      `${level ? liveRings(level).length : '–'} rings (2016: ${liveRings(base).length}) · ` +
      `${s.moved} moved, ${s.removed} removed, ${s.added} added` +
      `${s.finish ? ' · finish moved' : ''}${s.timer ? ' · timer changed' : ''}` +
      ` · ${s.linePoints > 0 ? `your line, ${s.linePoints} points` : '2016’s line'}`
    const dirty = isDirty(history)
    statusEl.textContent =
      dirty && !status.startsWith('Sav') ? `Unsaved changes. ${status}` : status
    problemsEl.textContent = problems.join(' ')
    const sel = d.selection
    selectionEl.textContent = sel
      ? `${entityName(level, base, sel)} · ${
          { '2016': 'as 2016 put it', moved: 'moved', added: 'added', removed: 'removed' }[
            entityState(d, sel)
          ]
        }${rotating ? ' · turning' : ''}`
      : 'Nothing. Click a handle.'
    const removed = sel ? entityState(d, sel) === 'removed' : false
    const point = sel?.kind === 'point'
    rotateB.disabled = !sel || removed || busy || point
    rotateB.textContent = rotating ? 'Move (W)' : 'Turn (E)'
    addB.disabled = sel?.kind !== 'ring' || removed || busy
    removeB.disabled = !sel || sel.kind === 'finish' || removed || busy
    revertB.disabled = !sel || busy || point || (entityState(d, sel) !== 'moved' && !removed)
    const ownLine = linePoints(d) !== null
    editLineB.disabled = busy || ownLine
    line2016B.disabled = busy || !ownLine
    snapB.disabled = busy || sel?.kind !== 'ring' || removed || !level
    addPointB.disabled =
      busy || !point || (linePoints(d)?.length ?? 0) >= PLAYER_COURSE_LIMITS.points.max
    for (const [input, v] of [
      [timeIn, (level ?? base).timer.timeLimit],
      [parIn, (level ?? base).timer.bonusParTime],
    ] as const) {
      if (document.activeElement !== input && input.value !== String(v)) input.value = String(v)
    }
    if (noteIn.value !== noteText && document.activeElement !== noteIn) noteIn.value = noteText
    undoB.disabled = !canUndo(history) || busy
    redoB.disabled = !canRedo(history) || busy
    saveB.disabled = busy || !level || (!dirty && noteText.trim() === '')
    back2016B.disabled = busy || (diskFrom === null && overrideText(d.override) === null)
    flyB.disabled = busy || !level
    fly2016B.disabled = busy
    topB.textContent = cam.topDown ? 'Orbit' : 'Top-down'
    warningList.replaceChildren(
      ...evaluation.warnings.map((w) =>
        make('li', { className: w.severity, textContent: w.message }),
      ),
    )
  }

  // ── camera ───────────────────────────────────────────────────────────────
  const frameArea = (): void => {
    const area = playerCourseArea(base)
    if (area) cam.frame(area)
  }
  const frame = (): void => {
    const sel = selected()
    const pose = sel
      ? (shippedPose(draft(), evaluation.level ?? base, sel) ?? shippedPose(draft(), base, sel))
      : null
    if (pose) cam.focus(new THREE.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]))
    else frameArea()
  }

  // ── pointer and keys ─────────────────────────────────────────────────────
  const _v = new THREE.Vector3()
  const screenOf = (x: number, y: number, z: number): ScreenPoint | null => {
    const rect = host.canvas.getBoundingClientRect()
    _v.set(x, y, z).project(cam.camera)
    if (_v.z > 1 || _v.z < -1) return null
    return {
      x: rect.left + ((_v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - _v.y) / 2) * rect.height,
    }
  }
  const click = (e: PointerEvent): void => {
    const hit = nearestWithin(
      handles.map((h) => screenOf(h.at[0], h.at[1], h.at[2])),
      e.clientX,
      e.clientY,
      DESK_POLICY.pickPixels,
    )
    const next = hit === null ? null : (handles[hit] as Handle).entity
    if (!sameEntity(next, selected())) rotating = rotating && next !== null
    apply(selectEntity(draft(), next))
  }
  let down: { x: number; y: number; onGizmo: boolean } | null = null
  const onPointerDown = (e: PointerEvent): void => {
    if (!active || e.button !== 0) return
    down = { x: e.clientX, y: e.clientY, onGizmo: gizmo.axis !== null }
  }
  const onPointerUp = (e: PointerEvent): void => {
    const d = down
    down = null
    if (!active || busy || !d || e.button !== 0 || d.onGizmo || dragging || e.altKey) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > DESK_POLICY.clickSlopPixels) return
    click(e)
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!active) return
    const target = e.target as HTMLElement | null
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
    const action = deskKeyAction(e)
    if (!action) return
    e.preventDefault()
    if (dragging) return
    if (action === 'undo') step(undo)
    else if (action === 'redo') step(redo)
    else if (action === 'delete') removeSelected()
    else if (action === 'deselect') apply(selectEntity(draft(), null))
    // DEV-570: Maya's W and E (R turned a ring until then). A ring and a turn
    // indicator move and turn; nothing here scales, and Q has no handles to hide.
    else if (action === 'tool-move' || action === 'tool-rotate') {
      const sel = selected()
      const want = action === 'tool-rotate' && !!sel && sel.kind !== 'point'
      if (want !== rotating) toggleRotate()
    } else if (action === 'frame') frame()
    else if (action === 'frame-all') frameArea()
    else if (action === 'top-down') {
      cam.setTopDown(!cam.topDown)
      renderPanel()
    }
  }
  host.canvas.addEventListener('pointerdown', onPointerDown)
  host.canvas.addEventListener('pointerup', onPointerUp)
  globalThis.addEventListener('keydown', onKeyDown)

  const setActive = (on: boolean): void => {
    active = on
    el.style.display = on ? '' : 'none'
    cam.controls.enabled = on && !dragging
    gizmo.enabled = on
    view.root.visible = on
  }

  // ── start ────────────────────────────────────────────────────────────────
  frameArea()
  syncGround()
  changed()
  console.info(
    `editor: shipped mission ${id} opened (DEV-540), ${input.disk === null ? 'no override on disk' : 'over its override'}` +
      `${input.opened.restored ? ', this browser’s unsaved draft restored' : ''}` +
      `${problems.length > 0 ? ` — ${problems.join(' ')}` : ''}`,
  )

  const probe = () => {
    const d = draft()
    const level = evaluation.level
    return {
      kind: 'shipped' as const,
      id,
      active,
      busy,
      groundReady: ground !== NO_GROUND,
      dirty: isDirty(history),
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      undoDepth: history.past.length,
      selection: d.selection,
      rotating,
      valid: level !== null,
      rings: (level ? liveRings(level) : []).map((r) => ({
        key: ringKey(r),
        pos: [r.pos[0], r.pos[1], r.pos[2]],
        trigger: [r.trigger.pos[0], r.trigger.pos[1], r.trigger.pos[2]],
      })),
      baseRings: liveRings(base).map((r) => ({
        key: ringKey(r),
        pos: [r.pos[0], r.pos[1], r.pos[2]],
        trigger: [r.trigger.pos[0], r.trigger.pos[1], r.trigger.pos[2]],
      })),
      handles: handles.map((h) => ({ entity: h.entity, at: [...h.at], state: h.state })),
      finish: level?.finish ? [...level.finish.pos] : null,
      // DEV-541: the file's own control points, or null on 2016's line.
      linePoints: linePoints(d)?.map((p) => [p[0], p[1], p[2]]) ?? null,
      timer: level ? { ...level.timer } : null,
      overrideText: overrideText(d.override),
      warnings: evaluation.warnings.map((w) => w.kind),
      status,
      problems: [...problems],
      saved: lastSave ? { ...lastSave } : null,
      saveError,
      drawnRings: view.rings()?.count ?? 0,
      drawnTurns: turns?.count ?? 0,
      onDisk: diskFrom !== null,
      flying,
      lastFlight,
      gizmo: { attached: gizmo.object !== undefined, axis: gizmo.axis, dragging, mode: gizmo.mode },
      topDown: cam.topDown,
      camera: {
        position: cam.camera.position.toArray(),
        target: cam.controls.target.toArray(),
      },
    }
  }

  const debug: DeskDebug = {
    screenOf: (x, y, z) => screenOf(x, y, z),
    ringGeometry: () => ringGeometryOf(view.rings()),
    lineSamples: () => ((evaluation.level ?? base).route ?? []).map((p) => [p[0], p[1], p[2]]),
    groundMarks: () => ({ rings: [], under: [], propRings: [], propLine: [] }),
    groundAt: (x, z) => ground.surfaceAt(x, z),
    ...gizmoDebug(screenOf),
    recordedFlight: () => [],
    propsNear: () => null,
    evaluateCost: () => ({ withProps: 0, withoutProps: 0, props: false }),
    propMatrix: () => null,
    propBase: () => null,
    propBox: () => null,
  }

  const resume = (result: PlaytestResult | null): void => {
    busy = false
    if (result && flying) {
      lastFlight = {
        which: flying,
        rings: result.ringsTaken,
        finished: result.finished,
        seconds: result.seconds,
      }
      status = `Back from ${flying === '2016' ? '2016’s course' : 'your course'}: ${result.ringsTaken}/${result.ringsTotal} rings${
        result.seconds === null ? '' : `, ${result.seconds.toFixed(2)} s`
      }.`
    }
    flying = null
    setActive(true)
    groundOf = null
    syncGround()
    changed()
  }

  return {
    frame(seconds) {
      if (view.root.parent !== host.scene) host.scene.add(view.root)
      if (syncGround()) changed()
      cam.update(seconds)
      view.update(cam.camera)
      cam.camera.getWorldPosition(_v)
      const eye = _v.clone()
      for (const m of handleGroup.children) {
        const d = m.position.distanceTo(eye)
        m.scale.setScalar(d * DESK_POLICY.handleScreenFraction * (relative.get(m) ?? 1))
      }
      return cam.camera
    },
    suspend() {
      setActive(false)
    },
    resume,
    recorded() {
      resume(null)
    },
    probe,
    debug,
  }
}
