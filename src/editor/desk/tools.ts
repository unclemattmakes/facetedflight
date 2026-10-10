// src/editor/desk/tools.ts: Maya's tools on the desk, and the desk's key list,
// as pure functions. DEV-570.
//
// Matt, 2026-10-02: *"editor needs a way to control rotation of the platform
// (use maya hotkeys plz)"*. The platform is the START PAD (his own word for it
// on 2026-09-28, quoted in `content/player-course.ts`): DEV-475 made it a thing
// to pick and aim, but its aim sat behind R and an AIM PAD button, and the
// only door to it said so in a help line at the foot of a long panel.
//
// So the desk has Maya's four tools, chosen by Maya's four keys, and the
// gizmo shows the one chosen on whatever is selected:
//
//   Q  Select   pick things; no handles drawn
//   W  Move     the arrows (a point on X, Y and Z; the pad and a prop on X and Z,
//               seated on the ground under them)
//   E  Rotate   the Y ring (the pad's heading, a prop's spin)
//   R  Scale    the scale handles (a prop's size; uniform, as the format keeps one)
//
// The tool is the DESK's, not the selection's, and it stays chosen as the
// selection changes, as Maya's does. A thing that cannot take the tool (a
// point has no heading, the pad no size) shows its arrows instead, and the
// panel says so in words (`toolNote`).
//
// No three and no DOM here, so `tests/unit/editor-desk.test.ts` runs it in node.

/** The four tools, Maya's: Q, W, E, R. */
export type DeskTool = 'select' | 'move' | 'rotate' | 'scale'

/** Every tool, in the order of their keys. */
export const DESK_TOOLS: readonly DeskTool[] = ['select', 'move', 'rotate', 'scale']

/** Each tool's key and its name on the panel. */
export const TOOL_KEYS: Readonly<
  Record<DeskTool, { readonly key: string; readonly name: string }>
> = {
  select: { key: 'Q', name: 'Select' },
  move: { key: 'W', name: 'Move' },
  rotate: { key: 'E', name: 'Rotate' },
  scale: { key: 'R', name: 'Scale' },
}

/** What the gizmo can be held on: a point of the line, the start pad, a placed prop. */
export type DeskPicked = 'point' | 'pad' | 'prop'

/** What each kind of thing can do: the tools it takes, beside Select. */
const TAKES: Readonly<Record<DeskPicked, readonly DeskTool[]>> = {
  point: ['move'],
  pad: ['move', 'rotate'],
  prop: ['move', 'rotate', 'scale'],
}

/** The gizmo for a picked thing under a tool: its mode and the axes it shows, or null for none. */
export interface DeskGizmo {
  readonly mode: 'translate' | 'rotate' | 'scale'
  readonly x: boolean
  readonly y: boolean
  readonly z: boolean
  /** The tool asked for something this thing does not do, and it shows its arrows instead. */
  readonly fallback: boolean
}

/**
 * The gizmo the desk shows on `picked` (null: nothing picked) under `tool`.
 * Select shows none. A tool the thing does not take falls back to Move, said
 * by `fallback`. The pad and a prop move on X and Z only: the desk seats them
 * on the ground, so a Y arrow would be a handle that does nothing.
 */
export const gizmoFor = (picked: DeskPicked | null, tool: DeskTool): DeskGizmo | null => {
  if (picked === null || tool === 'select') return null
  const takes = TAKES[picked].includes(tool)
  const t: DeskTool = takes ? tool : 'move'
  if (t === 'rotate') return { mode: 'rotate', x: false, y: true, z: false, fallback: false }
  if (t === 'scale') return { mode: 'scale', x: true, y: true, z: true, fallback: false }
  const level = picked !== 'point'
  return { mode: 'translate', x: true, y: !level, z: true, fallback: !takes }
}

/**
 * The panel's line under the tools: what the tool does to what is picked, in
 * words, and the keys for what else it can do.
 */
export const toolNote = (picked: DeskPicked | null, tool: DeskTool): string => {
  const what = picked === 'point' ? 'The point' : picked === 'pad' ? 'The start pad' : 'The prop'
  if (picked === null) {
    return tool === 'select'
      ? 'Select (Q): click a point, the start pad or a prop. No handles are drawn.'
      : `${TOOL_KEYS[tool].name} (${TOOL_KEYS[tool].key}) is ready: click a point, the start pad or a prop.`
  }
  if (tool === 'select') return `${what} is selected. W moves it.`
  const g = gizmoFor(picked, tool)
  const can =
    picked === 'point'
      ? 'A point only moves.'
      : picked === 'pad'
        ? 'W moves the pad, E turns it.'
        : 'W moves the prop, E turns it, R sizes it.'
  if (g?.fallback) {
    const verb = tool === 'rotate' ? 'turn' : 'scale'
    return `${what} does not ${verb}, so its arrows are shown. ${can}`
  }
  if (tool === 'rotate') return `Drag the ring to turn ${what.toLowerCase()}. ${can}`
  if (tool === 'scale') return `Drag a handle to size ${what.toLowerCase()}. ${can}`
  return `Drag an arrow to move ${what.toLowerCase()}. ${can}`
}

/**
 * The size a scale drag asks for, from the proxy's scale and the size the drag
 * began at: the axis that moved furthest from where it began, since a prop has
 * one size (the format's `scale`) and any of the gizmo's handles may be pulled.
 */
export const uniformScaleOf = (scale: readonly [number, number, number], from: number): number => {
  let best = from
  let bestD = 0
  for (const s of scale) {
    const d = Math.abs(s - from)
    if (Number.isFinite(s) && d > bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

/**
 * Every key and mouse gesture the desk answers, in the order the panel lists
 * them. ONE list: the panel prints it, DEVIATIONS' DEV-570 row quotes it, and
 * the unit test holds `deskKeyAction` to the keys in it.
 */
export const DESK_KEY_LIST: readonly {
  readonly group: 'Tools' | 'Edit' | 'Camera'
  readonly keys: string
  readonly does: string
}[] = [
  { group: 'Tools', keys: 'Q', does: 'Select: pick without handles' },
  { group: 'Tools', keys: 'W', does: 'Move: arrows on the point, pad or prop' },
  { group: 'Tools', keys: 'E', does: 'Rotate: turn the start pad or a prop' },
  { group: 'Tools', keys: 'R', does: 'Scale: size a prop' },
  { group: 'Edit', keys: 'Click the ground', does: 'add a point at the end of the line' },
  { group: 'Edit', keys: 'Click the line', does: 'insert a point' },
  {
    group: 'Edit',
    keys: 'Click a point, the pad’s green handle or a prop',
    does: 'select it',
  },
  { group: 'Edit', keys: 'Shift+click a ring', does: 'skip it' },
  { group: 'Edit', keys: 'Delete or Backspace', does: 'delete the selected point or prop' },
  { group: 'Edit', keys: 'Ctrl+Z', does: 'undo' },
  { group: 'Edit', keys: 'Ctrl+Y or Ctrl+Shift+Z', does: 'redo' },
  { group: 'Edit', keys: 'Esc', does: 'stop placing a prop, then drop the selection' },
  { group: 'Camera', keys: 'Alt+drag, or drag', does: 'orbit' },
  { group: 'Camera', keys: 'Alt+middle-drag, middle-drag or Shift+drag', does: 'pan' },
  { group: 'Camera', keys: 'Alt+right-drag or the wheel', does: 'zoom' },
  { group: 'Camera', keys: 'F', does: 'frame the selection (the island with none)' },
  { group: 'Camera', keys: 'A', does: 'frame the whole island' },
  { group: 'Camera', keys: 'T', does: 'top-down map, and back' },
  {
    group: 'Camera',
    keys: 'Hold right',
    does: 'fly: the mouse looks, WASD moves, Q/E down and up, the wheel sets the speed',
  },
]
