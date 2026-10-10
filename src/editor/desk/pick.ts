// src/editor/desk/pick.ts — what a click or a key means, as pure functions.
// DEV-469.
//
// No three and no DOM here, so `tests/unit/editor-desk.test.ts` runs them in
// node. Picking is done in SCREEN space: a handle is picked by how far the
// click landed from where the handle is DRAWN, in pixels, which is what a
// player aims at — a world-space ray against a handle that is a constant size
// on screen would need its radius re-derived from the camera for every test.

/** A point on screen, CSS pixels. */
export interface ScreenPoint {
  readonly x: number
  readonly y: number
}

/** The index of the nearest point within `reach` pixels of (x, y), or null. Nulls are off screen. */
export const nearestWithin = (
  points: readonly (ScreenPoint | null)[],
  x: number,
  y: number,
  reach: number,
): number | null => {
  let best: number | null = null
  let bestD = reach
  points.forEach((p, i) => {
    if (!p) return
    const d = Math.hypot(p.x - x, p.y - y)
    if (d <= bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/**
 * The nearest place on a screen-space polyline to (x, y), within `reach`
 * pixels: the segment it falls on and how far along that segment (0..1), or
 * null. `points[i]` null (behind the eye) breaks the line there.
 */
export const nearestOnPolyline = (
  points: readonly (ScreenPoint | null)[],
  x: number,
  y: number,
  reach: number,
): { readonly segment: number; readonly u: number; readonly pixels: number } | null => {
  let best: { segment: number; u: number; pixels: number } | null = null
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0
    const d = Math.hypot(a.x + u * dx - x, a.y + u * dy - y)
    if (d <= reach && (!best || d < best.pixels)) best = { segment: i, u, pixels: d }
  }
  return best
}

/** The desk's keyboard: what a key press asks for, or null for a key it does not use. */
export type DeskKeyAction =
  | 'delete'
  | 'undo'
  | 'redo'
  | 'deselect'
  | 'top-down'
  | 'frame'
  // DEV-570: A frames the whole island (Maya's "frame all").
  | 'frame-all'
  // DEV-570: Maya's tools, Q W E R (`tools.ts`).
  | 'tool-select'
  | 'tool-move'
  | 'tool-rotate'
  | 'tool-scale'

export interface KeyLike {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * Delete or Backspace deletes the selected point; Ctrl+Z undoes; Ctrl+Y and
 * Ctrl+Shift+Z redo (Cmd on a Mac); Escape drops the selection; T toggles the
 * top-down view; F frames the selected point, or the island with none (Maya's
 * and Unreal's F, DEV-472); A frames the island (Maya's, DEV-570); Q, W, E
 * and R pick Maya's select, move, rotate and scale tools (DEV-570; R aimed the
 * pad from DEV-475 until then, and E does now). Nothing else is the desk's.
 * The fly's own keys (WASD, Q and E while the right button is held) are the
 * camera's: the desk ignores its keys while the eye flies (`index.ts`).
 */
export const deskKeyAction = (e: KeyLike): DeskKeyAction | null => {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (mod && !e.altKey) {
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (k === 'y') return 'redo'
    return null
  }
  if (e.altKey) return null
  if (k === 'Delete' || k === 'Backspace') return 'delete'
  if (k === 'Escape') return 'deselect'
  if (k === 't' && !e.shiftKey) return 'top-down'
  if (k === 'f' && !e.shiftKey) return 'frame'
  if (e.shiftKey) return null
  // DEV-570: Maya's hands.
  if (k === 'a') return 'frame-all'
  if (k === 'q') return 'tool-select'
  if (k === 'w') return 'tool-move'
  if (k === 'e') return 'tool-rotate'
  if (k === 'r') return 'tool-scale'
  return null
}
