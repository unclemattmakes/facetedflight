// src/editor/desk/panel.ts — the desk's side panel, plain DOM. DEV-469.
//
// Flat only: the desk never runs in a headset, so neither does this. Plain DOM
// rather than a canvas plate because a desktop editor wants text fields and a
// cursor, and because every value here is a number somebody types.
//
// The panel holds no state of its own. `render(state)` draws what the desk says
// is true, and every control reports an intent through `PanelActions`; the desk
// turns intents into core commands and draws again. So a value in a field is
// always the draft's, clamped, and never a second copy that could disagree.
//
// Keys typed into a FIELD stay in it: a field's `keydown` stops propagating,
// so the game's keyboard (Backspace is its pause) and the desk's shortcuts
// (Delete, Ctrl+Z) never see a number typed into the gap field. A key pressed
// with a BUTTON focused goes on, so Ctrl+Z still undoes after pressing Top-down.
//
// Every control carries `data-editor="<name>"`, which is how
// `editor-desk.spec.ts` names them (rows by name, never by position).
//
// ── DEV-473: a panel a person can read ────────────────────────────────────
//
// Matt's first session (docs/plan/EDITOR-PLAYTEST-2026-09-27.md): *"i don't
// know what the start/finish sliders do"*, *"not sure what the point 4 height
// means"*, *"it'd be nice if ring-gap was on a slider"*. So:
//
//  · the RING GAP is a slider with the number still typable beside it, both
//    bounded by `PLAYER_COURSE_LIMITS` and stepped by the format's own gap
//    quantum, and a line under it says how many rings that makes;
//  · the FINISH slider says what it is (*"Finish: how far along the line"*)
//    and how far that is, and moves the finish LIVE, as it is dragged — the
//    world draws it as a labelled hoop (`finish-marker.ts`) — one undo step
//    per drag;
//  · HEIGHT is two sentences: *"New points are placed N m above the ground"*,
//    always, and *"Selected point K: N m above ground"* while one is selected.
//    It was one field whose meaning changed with the selection;
//  · every control carries a one-line tooltip (`PANEL_TIPS`).
//
// ── DEV-475: the start is a PAD, and the Start slider is gone ─────────────
//
// Matt's answer: *"a visible hover-pad marker dragged anywhere on the island
// and aimed … It replaces the Start slider."* So the panel has a START PAD
// group in its place: MOVE PAD picks the pad (as a click on its green handle
// does) and the gizmo drags it; AIM PAD turns the gizmo to its Y ring (R); and
// the heading is a number too, *"The ship faces N°"*, for the exact angle.
//
// ── DEV-478: why the course is refused, and the button that fixes it ─────
//
// A buried ring is an error, and an error greys out FLY, SAVE FILE and COPY
// LINK. Greyed buttons with no reason are a puzzle, so the reason is said
// right under them (`refusalReadout`: the first error, and how many more),
// and beside it LIFT CLEAR OF THE GROUND, which raises the line until no ring
// and no stretch of it is in or near the ground — one undo step.
//
// ── DEV-569: the way back, at the top ─────────────────────────────────────
//
// Matt, 2026-10-02: *"need a way to get back to the main game from the
// editor"*. There was one, LEAVE EDITOR, at the foot of a panel that scrolls:
// below the warnings, the remix list and three island buttons, under the fold
// on any screen he plays on. It is BACK TO HANGAR now, in the panel's header,
// which stays put while the panel scrolls. The hangar, because that is where
// the editor is entered (the Custom Courses shelf's MAKE A COURSE, DEV-558)
// and where every other mode starts; the title is one step further back and
// holds nothing to do. The draft is kept in this browser on every edit, so it
// asks first only when this browser would not keep it (`leave.ts`).
//
// ── DEV-570: Maya's tools, and every key written down ─────────────────────
//
// A TOOL row under the header: Select (Q), Move (W), Rotate (E), Scale (R),
// the chosen one lit, and a line saying what it does to what is picked
// (`tools.ts`). The two help lines at the foot are a key list now, printed
// from `DESK_KEY_LIST`, the one list the unit test holds the keys to.

import { PLAYER_COURSE_LIMITS, PLAYER_COURSE_SHAPE } from '@/content/player-course'
import { buttonMaker, make, tipper } from '@/editor/ui/dom'
import { isolateTextEntryKeys } from '@/input/text-entry'
import { createLightGroup, type LightPanelActions, type LightPanelState } from './light-panel'
import { createPropGroup, type PropPanelActions, type PropPanelState } from './prop-panel'
import { DESK_KEY_LIST, DESK_TOOLS, type DeskTool, TOOL_KEYS } from './tools'

/**
 * One line per control, shown as its tooltip. Keyed by the control's
 * `data-editor` name; the e2e holds every control on the panel to having one.
 */
export const PANEL_TIPS = {
  reroll: 'Pick a new random name for this course.',
  sky: 'The base: the world, its sun and ring style this course borrows. Changing it reloads the island.',
  'gap-slider': `Distance between rings along the line, ${PLAYER_COURSE_LIMITS.gapMetres.min}–${PLAYER_COURSE_LIMITS.gapMetres.max} m. Drag to space them out or pack them in.`,
  gap: 'Distance between rings, in metres. Type a number and press Enter.',
  'time-limit': `Seconds a player has to finish, ${PLAYER_COURSE_LIMITS.timeLimitSeconds.min}–${PLAYER_COURSE_LIMITS.timeLimitSeconds.max}.`,
  height:
    'How high above the ground a point lands when you click the ground. The default lets a ring clear it.',
  'point-height':
    'The selected point, in metres above the ground under it. Type to raise or lower it.',
  finish:
    'Where the finish gate stands: 100 % is the end of the line. Drag it and watch the orange FINISH hoop move.',
  pad: 'Pick the start pad to drag it with the arrows (or click its green handle). It sits on the ground where you drop it.',
  // DEV-570: Maya's tools.
  'tool-select': 'Select (Q): pick a point, the start pad or a prop without drawing its handles.',
  'tool-move': 'Move (W): drag the arrows to move the picked point, start pad or prop.',
  'tool-rotate':
    'Rotate (E): drag the ring to turn the start pad (where the ship faces) or a prop.',
  'tool-scale': 'Scale (R): drag a handle to make the picked prop bigger or smaller.',
  // DEV-501: the first ring anchored to the pad.
  anchor:
    'Put ring 1 one gap straight ahead of the start pad, following it from then on. Moves the line’s start. One undo step.',
  anchored:
    'Ring 1 is anchored to the pad: one gap straight ahead. Move or aim the pad, or change the gap, to move it.',
  'pad-rotate':
    'Aim the start pad: drag the ring to turn it (E). The green arrow is where the ship will face.',
  'pad-yaw':
    'The heading the ship faces on the start pad, in degrees. Type a number and press Enter.',
  undo: 'Undo the last change (Ctrl+Z).',
  redo: 'Redo what you undid (Ctrl+Y).',
  delete: 'Delete the selected point (Delete).',
  'top-down': 'Switch between a map view from straight above and the orbit view (T).',
  frame: 'Bring the whole island back into view.',
  fly: 'Fly the course from its start.',
  'fly-here': 'Fly the course from the selected point, to try one stretch.',
  'save-file': 'Save the course as a .ffcourse file you can send or keep.',
  'copy-link': 'Copy a link that opens this course in the game.',
  lift: 'Raise the line until every ring and all of the line clear the ground. One undo step.',
  // DEV-486: the fix beside a too-sharp run-in.
  'run-in-fix':
    'Straighten the run from the start pad onto the line: aim the pad, or move it behind point 1. One undo step.',
  // DEV-889: the fix beside "the line ends too close to the finish".
  'runout-fix':
    'Add a point past the end of the line, straight on, so the racers can fly through the finish gate. One undo step.',
  // DEV-491: fly-to-author.
  record:
    'Fly free from the start pad and press R to record; press R again and the flight becomes the line. One undo step.',
  link: 'The last link made. Copy it by hand if the clipboard refused.',
  remix: 'Start a new course from one you keep, credited to it.',
  drafts: 'Open one of your last few drafts. The one you are on is kept first.',
  new: 'Start a new, empty course. This one stays in your drafts.',
  // DEV-490: an island of the course's own.
  'island-map':
    'A new course on an island from a greyscale heightmap (PNG or .r16). Its map rides in the course file.',
  // DEV-500: a water level, on any base.
  water:
    'A flat water surface at a height you choose: a flooded canyon, a fjord, a lake. It is the sea: flown into, it crashes.',
  'water-level': 'The water’s height. Rings and the pad under it are buried.',
  // DEV-493
  'island-seed': 'A new course on an island grown from a seed and four sliders. It fits in a link.',
  // DEV-499: where the panel says a course's map is not in this browser.
  'island-lost-new':
    'Start a new course on a new island, from a heightmap. This one stays in your drafts.',
  'island-reopen':
    'Pick this course’s heightmap file again. It is accepted only if it is the same file, byte for byte.',
  // DEV-569: in the header, so it is always in view.
  leave: 'Back to the hangar. Your draft is kept in this browser; Make a course opens it again.',
  // DEV-878: the top bar, the corner and the sheet.
  share: 'Copy a link, save a file, start a new course or remix one you keep.',
  problems: 'What is wrong with this course, each with the button that fixes it.',
  keys: 'Every key and mouse gesture in the editor.',
  'keys-close': 'Close the list of keys.',
} as const

export type PanelTipName = keyof typeof PANEL_TIPS

/** Metres as a person reads them: `850 m`, `1.2 km`, `12 km`. */
export const formatDistance = (metres: number): string => {
  if (!Number.isFinite(metres)) return '—'
  const m = Math.max(0, metres)
  if (m < 1000) return `${Math.round(m)} m`
  const km = m / 1000
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`
}

/** Under the gap slider: what the gap makes of this line. */
export const ringsReadout = (rings: number | null, lineMetres: number | null): string => {
  if (lineMetres === null || !(lineMetres > 0)) return 'Place two points to make a line.'
  if (rings === null) return `No rings yet on ${formatDistance(lineMetres)} of line.`
  return `${rings} ring${rings === 1 ? '' : 's'} on ${formatDistance(lineMetres)} of line.`
}

/**
 * DEV-478: under the refused buttons, why they are refused: the first error,
 * and how many more. Empty when nothing is refused.
 */
export const refusalReadout = (errors: readonly string[]): string => {
  if (errors.length === 0) return ''
  const more = errors.length - 1
  return `Can't fly or share yet: ${errors[0]}${more > 0 ? ` (and ${more} more)` : ''}`
}

/**
 * DEV-889: the problems pop's banner. The pop lists every problem under it, so
 * the banner no longer says the first one again (it did, on every pop): it
 * says what the red rows below stop. The greyed buttons' tips keep
 * `refusalReadout`, where the first error is all the room there is.
 */
export const refusalLead = (errors: readonly string[]): string => {
  if (errors.length === 0) return ''
  return errors.length === 1
    ? "Can't fly or share yet: fix the red problem below."
    : `Can't fly or share yet: fix the ${errors.length} red problems below.`
}

/** Beside the finish slider: how far along the line the finish stands. */
export const finishReadout = (t: number, lineMetres: number | null): string => {
  const pct = `${Math.round(Math.min(1, Math.max(0, t)) * 100)} %`
  if (lineMetres === null || !(lineMetres > 0)) return pct
  return `${pct} · ${formatDistance(t * lineMetres)} of ${formatDistance(lineMetres)}`
}

export interface PanelSky {
  readonly id: string
  readonly title: string
  /** DEV-875: the place the base is on, for the picker's groups. */
  readonly place?: string
}

export interface PanelWarning {
  readonly severity: 'error' | 'warning' | 'note'
  readonly message: string
  /** DEV-486: a fix beside it, labelled with what it will do (the run-in's). */
  readonly fix?: string
  /** DEV-889: which fix the button runs; the run-in's when absent. */
  readonly fixKind?: 'run-in' | 'runout'
}

export interface PanelState {
  readonly name: string
  readonly island: string
  /** DEV-490: why the draft's own island could not be built; empty when it was. */
  readonly islandTrouble: string
  /** DEV-499: the draft's imported map is not in this browser: offer New island… and Open a map file…. */
  readonly islandLost: boolean
  readonly sky: string
  readonly skies: readonly PanelSky[]
  readonly gap: number
  readonly timeLimit: number
  /** Metres above the ground a clicked point is placed at. */
  readonly placeHeight: number
  /** Metres the selected point stands above the ground under it; null with nothing selected. */
  readonly selectedHeight: number | null
  /** DEV-475: the pad's heading, degrees; and whether it is picked, and being aimed. */
  readonly padYaw: number
  readonly padPicked: boolean
  readonly padRotate: boolean
  /** DEV-570: Maya's tool, and what it does to what is picked, in words. */
  readonly tool: DeskTool
  readonly toolNote: string
  /** DEV-501: the line's first point is the pad's. */
  readonly anchored: boolean
  readonly finish: number
  /** DEV-476: the LIGHT group's state (`light-panel.ts`). */
  readonly light: LightPanelState
  /** DEV-504: the PROPS group's state (`prop-panel.ts`). */
  readonly props: PropPanelState
  /**
   * DEV-500: the course's water: world metres now, and the range the island
   * allows (its floor to its ceiling); `y` null when it has none.
   */
  readonly water: {
    readonly y: number | null
    /** DEV-876: the base has a sea of its own: the switch is on and stays on. */
    readonly own?: boolean
    readonly min: number
    readonly max: number
  }
  /** The line's length in metres, or null with fewer than two points. */
  readonly lineLength: number | null
  readonly selection: number | null
  readonly points: number
  readonly rings: number | null
  readonly courseId: string | null
  readonly authorLap: number | null
  readonly remixedFrom: string | null
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly canFly: boolean
  /** DEV-478: the errors that refuse Fly, Save file and Copy link, as messages. */
  readonly refusal: readonly string[]
  /** DEV-478: something is in or near the ground that Lift can raise clear of it. */
  readonly canLift: boolean
  readonly topDown: boolean
  readonly busy: boolean
  readonly warnings: readonly PanelWarning[]
  /** The library's courses, for Remix (DEV-467's list), newest first. */
  readonly library: readonly { readonly id: string; readonly name: string }[]
  /** DEV-889: the shelf of recent drafts (not the one being edited), newest first. */
  readonly drafts: readonly { readonly slot: string; readonly label: string }[]
  /** The last share: what Copy link or Save file did, said under the buttons. */
  readonly shared: string
  /** The last link made, for the reader to copy by hand if the clipboard refused. */
  readonly link: string
  // ── DEV-491 ──
  /** A recording flight can leave from here (the sky has a lift, nothing is busy). */
  readonly canRecord: boolean
  /** What the last recording made, said under its button; empty before one. */
  readonly recordNote: string
  // ── DEV-501 follow-up ──
  /**
   * Said when the desk turned the pad so ring 1 clears the ground, or when no
   * heading clears it from where the pad stands (move the pad); empty otherwise.
   */
  readonly padTurnNote: string
}

export interface PanelActions {
  /**
   * `live` while a slider is being dragged: the desk shows it at once and keeps
   * the drag as ONE undo step, closed by the release (`live` false).
   */
  gap(metres: number, live: boolean): void
  timeLimit(seconds: number): void
  /** The height a NEW point is placed at, metres above the ground. */
  height(metres: number): void
  /** The SELECTED point's height, metres above the ground under it. */
  pointHeight(metres: number): void
  /** DEV-475: pick the start pad, or drop it. */
  pad(): void
  /** DEV-475: turn the pad's gizmo between moving and aiming it. */
  padRotate(): void
  /** DEV-475: the ship's heading on the pad, degrees. */
  padYaw(degrees: number): void
  /** DEV-570: Maya's tool (Q, W, E, R). */
  tool(tool: DeskTool): void
  /** DEV-501: "Anchor to pad", one undo step. */
  anchor(): void
  /** As `gap`: `live` while dragged, one undo step per drag. */
  finish(t: number, live: boolean): void
  /** DEV-476: the LIGHT group's intents (`light-panel.ts`). */
  readonly light: LightPanelActions
  /** DEV-504: the PROPS group's intents (`prop-panel.ts`). */
  readonly props: PropPanelActions
  /** DEV-500: water on or off, and its level in world metres. */
  readonly water: {
    on(on: boolean): void
    level(worldY: number, live: boolean): void
  }
  sky(id: string): void
  reroll(): void
  undo(): void
  redo(): void
  deletePoint(): void
  topDown(): void
  frame(): void
  fly(): void
  /** DEV-478: lift the line clear of the ground. */
  lift(): void
  /** DEV-486: straighten a too-sharp run-in (the fix beside its warning). */
  straighten(): void
  flyFromHere(): void
  newCourse(): void
  /** DEV-490: "New island from a heightmap…". */
  importIsland(): void
  /** DEV-493: "New island from a seed". */
  seedIsland(): void
  /** DEV-499: "Open a map file…": the course's own map, picked again. */
  reopenMap(file: File): void
  /** DEV-569: back to the hangar (asking first only when the draft is not kept). */
  leave(): void
  saveFile(): void
  copyLink(): void
  remix(id: string): void
  /** DEV-889: open a draft from the shelf. */
  openDraft(slot: string): void
  /** DEV-889: extend the run-out past the finish. */
  extendRunout(): void
  /** DEV-491: fly free and record the flight as the line. */
  record(): void
}

export interface DeskPanel {
  /** The inspector, the right column (`#editor-panel`). */
  readonly element: HTMLElement
  /** DEV-878: the Share menu's dev-only section; `shipped-door.ts` mounts into it. */
  readonly devSlot: HTMLElement
  render(state: PanelState): void
  setVisible(on: boolean): void
  dispose(): void
}

/** The panel's look; DEV-540's shipped-mission panel wears it too (`shipped.ts`). */
export const PANEL_STYLE = `
#editor-panel{position:fixed;top:12px;right:12px;bottom:12px;width:300px;z-index:5;
  display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding:14px 14px 16px;
  box-sizing:border-box;background:rgba(10,16,24,.86);color:#e8f0f8;border-radius:10px;
  font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)}
#editor-panel h2{margin:0;font-size:12px;letter-spacing:.18em;color:#7fd3ff;font-weight:600}
#editor-panel .name{font-size:18px;font-weight:600;text-transform:capitalize}
#editor-panel .row{display:flex;align-items:center;gap:8px}
#editor-panel .row>label{flex:1;color:#b8c6d4}
#editor-panel input[type=number]{width:84px;background:#0c1520;color:#e8f0f8;border:1px solid #33475c;
  border-radius:5px;padding:4px 6px;font:inherit}
#editor-panel input[type=range]{flex:1}
#editor-panel select{flex:1;background:#0c1520;color:#e8f0f8;border:1px solid #33475c;border-radius:5px;padding:4px}
#editor-panel button{background:#1c2b3b;color:#e8f0f8;border:1px solid #3a5670;border-radius:6px;
  padding:6px 10px;font:inherit;cursor:pointer}
#editor-panel button:hover:not(:disabled){background:#27405a}
#editor-panel button:disabled{opacity:.45;cursor:default}
#editor-panel button.primary{background:#1f7a4d;border-color:#2fa56a;font-weight:600}
#editor-panel .buttons{display:flex;flex-wrap:wrap;gap:6px}
#editor-panel .facts{color:#9fb0c0;font-size:12px}
#editor-panel .warnings{margin:0;padding-left:16px;font-size:12px}
#editor-panel .warnings li.error{color:#ff7a7a}
#editor-panel .warnings li.warning{color:#ffc27a}
#editor-panel .warnings li.note{color:#9fd0ff}
#editor-panel .help{color:#7d8ea0;font-size:11px}
#editor-panel .refusal{color:#ff7a7a;font-size:12px}
#editor-panel .refusal:empty{display:none}
#editor-panel .group{display:flex;flex-direction:column;gap:4px}
#editor-panel .group>.head{color:#b8c6d4}
#editor-panel .readout{color:#9fb0c0;font-size:12px}
#editor-panel .sentence{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;color:#b8c6d4}
#editor-panel .sentence input[type=number]{width:64px}
#editor-panel{scroll-padding-top:64px}
#editor-panel select{min-width:0;max-width:100%}
#editor-panel .tools button{min-width:0}
#editor-panel .top{position:sticky;top:-14px;z-index:1;margin:-14px -14px 0;padding:12px 14px 8px;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
  background:rgb(12,19,28);border-radius:10px 10px 0 0;border-bottom:1px solid #22344a}
#editor-panel button.back{background:#16405a;border-color:#7fd3ff;font-weight:600}
#editor-panel button.back:hover:not(:disabled){background:#1f5677}
#editor-panel .tools{display:flex;gap:4px}
#editor-panel .tools button{flex:1;padding:5px 4px}
#editor-panel .tools button.on{background:#1f5f7a;border-color:#7fd3ff;font-weight:600}
#editor-panel .tools kbd{font:inherit;opacity:.7;margin-left:4px}
#editor-panel .keys{color:#7d8ea0;font-size:11px}
#editor-panel .keys summary{cursor:pointer;color:#9fb0c0}
#editor-panel .keys table{border-collapse:collapse;width:100%;margin-top:4px}
#editor-panel .keys th{text-align:left;color:#7fd3ff;font-weight:600;padding:6px 0 2px}
#editor-panel .keys td{vertical-align:top;padding:1px 0}
#editor-panel .keys td:first-child{color:#c8d6e4;padding-right:8px;width:45%}
`

/**
 * DEV-878: the chrome around the island (docs/plan/EDITOR-UX-2026-10-08.md,
 * layout A): a top bar of verbs, the tool strip floating on the view, the view
 * corner, the keys sheet, and the inspector's room beneath the bar. Appended
 * after `PANEL_STYLE`, which the shipped desk wears unchanged.
 */
export const CHROME_STYLE = `
#editor-topbar,#editor-tools,#editor-view,#editor-keys{font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8f0f8}
#editor-topbar button,#editor-tools button,#editor-view button,#editor-keys button{background:#1c2b3b;color:#e8f0f8;
  border:1px solid #3a5670;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}
#editor-topbar button:hover:not(:disabled),#editor-tools button:hover:not(:disabled),
#editor-view button:hover:not(:disabled),#editor-keys button:hover:not(:disabled){background:#27405a}
#editor-topbar button:disabled,#editor-tools button:disabled,#editor-view button:disabled{opacity:.45;cursor:default}
#editor-topbar button.primary{background:#1f7a4d;border-color:#2fa56a;font-weight:600}
#editor-topbar button.back{background:#16405a;border-color:#7fd3ff;font-weight:600}
#editor-topbar{position:fixed;top:0;left:0;right:0;height:44px;z-index:6;box-sizing:border-box;
  display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(10,16,24,.92);
  border-bottom:1px solid #22344a;box-shadow:0 2px 12px rgba(0,0,0,.3)}
#editor-topbar .name{font-size:16px;font-weight:600;text-transform:capitalize;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:34vw}
#editor-topbar .spacer{flex:1}
#editor-topbar .menu{position:relative}
#editor-topbar .pop{position:absolute;top:calc(100% + 8px);right:0;z-index:7;width:300px;box-sizing:border-box;
  display:flex;flex-direction:column;gap:8px;padding:12px;background:rgb(12,19,28);
  border:1px solid #33475c;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
#editor-topbar .pop[hidden],#editor-keys[hidden]{display:none}
#editor-topbar .pop .buttons{display:flex;flex-wrap:wrap;gap:6px}
#editor-topbar .pop .row{display:flex;align-items:center;gap:8px}
#editor-topbar .pop .row>label{flex:1;color:#b8c6d4}
#editor-topbar .pop select{flex:1;min-width:0;background:#0c1520;color:#e8f0f8;border:1px solid #33475c;border-radius:5px;padding:4px}
#editor-topbar .pop hr{width:100%;border:0;border-top:1px solid #22344a;margin:0}
#editor-topbar .pop .head{color:#7fd3ff;font-size:12px;letter-spacing:.12em;font-weight:600}
#editor-topbar .pop .group{display:flex;flex-direction:column;gap:4px}
#editor-topbar .pop .group .head{color:#b8c6d4;letter-spacing:0;font-weight:400}
#editor-topbar .devslot:empty{display:none}
#editor-topbar .devslot{border-top:1px solid #22344a;padding-top:8px}
#editor-topbar .facts{color:#9fb0c0;font-size:12px}
#editor-topbar .facts:empty{display:none}
#editor-topbar .refusal{color:#ff7a7a;font-size:12px}
#editor-topbar .refusal:empty{display:none}
#editor-topbar .warnings{margin:0;padding-left:16px;font-size:12px}
#editor-topbar .warnings:empty{display:none}
#editor-topbar .warnings li.error{color:#ff7a7a}
#editor-topbar .warnings li.warning{color:#ffc27a}
#editor-topbar .warnings li.note{color:#9fd0ff}
#editor-topbar .none{color:#9fb0c0;font-size:12px}
#editor-topbar button.pill{border-radius:999px;padding:5px 12px;font-size:12px}
#editor-topbar button.pill[data-state=ok]{border-color:#2fa56a;color:#9fe6bd}
#editor-topbar button.pill[data-state=warning]{border-color:#c98a3a;color:#ffc27a}
#editor-topbar button.pill[data-state=error]{border-color:#c85a5a;color:#ff9a9a;background:#3a1c22}
#editor-tools{position:fixed;top:56px;left:12px;z-index:5;display:flex;flex-direction:column;gap:6px;max-width:300px}
#editor-tools .tools{display:flex;gap:4px;padding:4px;background:rgba(10,16,24,.86);border-radius:10px;
  box-shadow:0 6px 24px rgba(0,0,0,.35)}
#editor-tools .tools button{padding:5px 9px;min-width:0}
#editor-tools .tools button.on{background:#1f5f7a;border-color:#7fd3ff;font-weight:600}
#editor-tools kbd{font:inherit;opacity:.7;margin-left:4px}
#editor-tools .readout{color:#c8d6e4;font-size:12px;text-shadow:0 1px 3px rgba(0,0,0,.9)}
#editor-tools .readout:empty{display:none}
#editor-view{position:fixed;bottom:12px;right:324px;z-index:5;display:flex;gap:6px;padding:4px;
  background:rgba(10,16,24,.86);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
#editor-view button{padding:5px 10px}
#editor-keys{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9;width:min(560px,92vw);
  max-height:80vh;overflow-y:auto;box-sizing:border-box;padding:16px 18px;background:rgb(12,19,28);
  border:1px solid #33475c;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.55)}
#editor-keys .head{display:flex;align-items:center;justify-content:space-between;color:#7fd3ff;
  font-size:12px;letter-spacing:.18em;font-weight:600}
#editor-keys table{border-collapse:collapse;width:100%;margin-top:6px;font-size:12px;color:#9fb0c0}
#editor-keys th{text-align:left;color:#7fd3ff;font-weight:600;padding:8px 0 2px}
#editor-keys td{vertical-align:top;padding:1px 0}
#editor-keys td:first-child{color:#c8d6e4;padding-right:10px;width:45%}
#editor-panel.inspector{top:56px}
#editor-panel .section{margin:6px 0 0;padding-top:8px;border-top:1px solid #22344a;font-size:12px;
  letter-spacing:.18em;color:#7fd3ff;font-weight:600}
#editor-panel .section:first-child{margin-top:0;border-top:0;padding-top:0}
`

export const createDeskPanel = (actions: PanelActions): DeskPanel => {
  const style = document.createElement('style')
  style.textContent = PANEL_STYLE + CHROME_STYLE
  document.head.appendChild(style)

  const el = document.createElement('aside')
  el.id = 'editor-panel'
  el.className = 'inspector'
  isolateTextEntryKeys(el)

  /** Name a control and give it its one-line tooltip (DEV-473). */
  const tip = tipper<PanelTipName>(PANEL_TIPS)
  const button = buttonMaker(tip)
  /**
   * Fields being typed in: `render` leaves these alone until the typing is
   * committed, then writes the draft's (clamped) value back, so a typed 5000
   * shows the 1000 the gap was clamped to rather than staying 5000.
   */
  const typing = new Set<HTMLInputElement>()
  const number = (
    name: PanelTipName,
    step: number,
    commit: (v: number) => void,
    bounds?: { readonly min: number; readonly max: number },
  ): HTMLInputElement => {
    const input = tip(make('input', { type: 'number', step: String(step) }), name)
    if (bounds) {
      input.min = String(bounds.min)
      input.max = String(bounds.max)
    }
    input.addEventListener('input', () => typing.add(input))
    // On change (Enter, blur, the spinner), not per keystroke: "4" on the way
    // to "450" is not a gap anybody asked for.
    input.addEventListener('change', () => {
      typing.delete(input)
      const v = Number.parseFloat(input.value)
      if (Number.isFinite(v)) commit(v)
    })
    return input
  }
  /**
   * A slider that acts LIVE (DEV-473): every `input` while it is dragged is a
   * `live` commit, the release a final one. The desk folds the drag into one
   * undo step.
   */
  const slider = (
    name: PanelTipName,
    bounds: { readonly min: number; readonly max: number },
    step: number,
    commit: (v: number, live: boolean) => void,
  ): HTMLInputElement => {
    const input = tip(
      make('input', {
        type: 'range',
        min: String(bounds.min),
        max: String(bounds.max),
        step: String(step),
      }),
      name,
    )
    input.addEventListener('input', () => commit(Number.parseFloat(input.value), true))
    input.addEventListener('change', () => commit(Number.parseFloat(input.value), false))
    // A slider DRAGGED with the mouse gives the keys back when it is let go,
    // so Ctrl+Z undoes the drag at once (a focused field keeps its keys, see
    // the header). One moved with the arrow keys keeps the focus: that person
    // is still using it. After the release's `change`, which fires first.
    input.addEventListener('pointerup', () => setTimeout(() => input.blur(), 0))
    return input
  }
  // A row's label carries its control's tooltip too, so hovering the words works.
  const row = (label: string, control: HTMLElement): HTMLElement =>
    make(
      'div',
      { className: 'row' },
      make('label', { textContent: label, title: control.title }),
      control,
    )

  const nameEl = make('div', { className: 'name' })
  nameEl.dataset.editor = 'name'
  const skySelect = tip(make('select'), 'sky')
  // ── DEV-500: the water, beside the base it floods ──
  const waterOn = tip(make('input', { type: 'checkbox' }), 'water')
  waterOn.addEventListener('change', () => actions.water.on(waterOn.checked))
  const waterSlider = slider('water-level', { min: 0, max: 1 }, 1, (v, live) =>
    actions.water.level(v, live),
  )
  const waterReadout = make('div', { className: 'readout' })
  waterReadout.dataset.editor = 'water-readout'
  skySelect.addEventListener('change', () => actions.sky(skySelect.value))
  // ── DEV-473: the ring gap, a slider and a field over one value ──────────
  const gapBounds = PLAYER_COURSE_LIMITS.gapMetres
  const gapStep = PLAYER_COURSE_SHAPE.gapQuantumMetres
  const gapSlider = slider('gap-slider', gapBounds, gapStep, actions.gap)
  const gapIn = number('gap', gapStep, (v) => actions.gap(v, false), gapBounds)
  const gapReadout = make('div', { className: 'readout' })
  gapReadout.dataset.editor = 'gap-readout'
  const timeIn = number(
    'time-limit',
    PLAYER_COURSE_SHAPE.timeLimitQuantumSeconds,
    actions.timeLimit,
    PLAYER_COURSE_LIMITS.timeLimitSeconds,
  )
  // ── DEV-473: height, said as two sentences ──────────────────────────────
  const heightIn = number('height', 1, actions.height)
  // No ceiling: a creator may want a line far over the trees. Never below the ground.
  heightIn.min = '0'
  const pointHeightIn = number('point-height', 1, actions.pointHeight)
  const pointHeightLead = make('span')
  const pointHeightRow = make(
    'div',
    { className: 'sentence', title: PANEL_TIPS['point-height'] },
    pointHeightLead,
    pointHeightIn,
    make('span', { textContent: 'm above ground' }),
  )
  pointHeightRow.dataset.editor = 'point-height-row'
  // ── DEV-570: Maya's tools ───────────────────────────────────────────────
  const toolBs = DESK_TOOLS.map((t) => {
    const b = button(`tool-${t}`, '', () => actions.tool(t))
    b.append(TOOL_KEYS[t].name, make('kbd', { textContent: TOOL_KEYS[t].key }))
    b.dataset.tool = t
    return b
  })
  const toolNoteEl = make('div', { className: 'readout' })
  toolNoteEl.dataset.editor = 'tool-note'
  // ── DEV-475: the start pad ──────────────────────────────────────────────
  const padB = button('pad', 'Move pad', actions.pad)
  const padRotateB = button('pad-rotate', 'Aim pad', actions.padRotate)
  // DEV-501: said when the first ring is the pad's; offered when it is not.
  const anchorB = button('anchor', 'Anchor ring 1 to pad', actions.anchor)
  const anchoredNote = tip(
    make('div', { className: 'sentence', textContent: 'Ring 1 is anchored to the pad.' }),
    'anchored',
  )
  // DEV-501 follow-up (Matt): when the desk turned the pad so ring 1 clears,
  // or found that no heading does.
  const padTurnNoteEl = make('div', { className: 'facts' })
  padTurnNoteEl.dataset.editor = 'pad-turn-note'
  const padYawIn = number('pad-yaw', PLAYER_COURSE_SHAPE.yawQuantumDegrees, actions.padYaw, {
    min: -180,
    max: 180,
  })
  // ── DEV-473: the finish, said plainly and moved live ────────────────────
  const finishIn = slider(
    'finish',
    { min: 0, max: 1 },
    PLAYER_COURSE_SHAPE.tQuantum,
    actions.finish,
  )
  const finishReadoutEl = make('span', { className: 'readout' })
  finishReadoutEl.dataset.editor = 'finish-readout'
  const lightGroup = createLightGroup(actions.light) // DEV-476
  const propGroup = createPropGroup(actions.props) // DEV-504
  const facts = make('div', { className: 'facts' })
  facts.dataset.editor = 'facts'
  const warningList = make('ul', { className: 'warnings' })
  warningList.dataset.editor = 'warnings'

  const undoB = button('undo', 'Undo', actions.undo)
  const redoB = button('redo', 'Redo', actions.redo)
  const deleteB = button('delete', 'Delete point', actions.deletePoint)
  const topB = button('top-down', 'Top-down', actions.topDown)
  const frameB = button('frame', 'Frame', actions.frame)
  const flyB = button('fly', 'Fly', actions.fly, 'primary')
  const flyHereB = button('fly-here', 'Fly from point', actions.flyFromHere)
  const saveB = button('save-file', 'Save file', actions.saveFile)
  const copyB = button('copy-link', 'Copy link', actions.copyLink)
  // DEV-478: why the buttons above are refused, and the fix for the ground.
  const refusalEl = make('div', { className: 'refusal' })
  const problemsNone = make('div', {
    className: 'none',
    textContent: 'Nothing is wrong with this course.',
  })
  refusalEl.dataset.editor = 'refusal'
  const liftB = button('lift', 'Lift clear of the ground', actions.lift)
  // ── DEV-491: fly-to-author ──
  const recordB = button('record', 'Record a flight', actions.record)
  // DEV-490: a new island, and what went wrong building the draft's own.
  const islandB = button('island-map', 'New island from a heightmap…', actions.importIsland)
  const seedB = button('island-seed', 'New island from a seed', actions.seedIsland)
  const islandTroubleEl = make('div', { className: 'refusal' })
  islandTroubleEl.dataset.editor = 'island-trouble'
  // DEV-499: Matt, *"should offer the choice of 'new' or 'open'"*.
  const lostNewB = button('island-lost-new', 'New island…', actions.importIsland)
  const reopenFile = make('input', { type: 'file', accept: '.png,.r16,.raw' })
  reopenFile.dataset.editor = 'island-reopen-file'
  // The hidden picker its visible button opens: it says what that button says, so
  // the panel sweep's every-control-has-a-tooltip holds of it too.
  reopenFile.title = PANEL_TIPS['island-reopen']
  reopenFile.style.display = 'none'
  reopenFile.addEventListener('change', () => {
    const f = reopenFile.files?.[0]
    reopenFile.value = ''
    if (f) actions.reopenMap(f)
  })
  const reopenB = button('island-reopen', 'Open a map file…', () => reopenFile.click())
  const lostRow = make('div', { className: 'buttons' }, lostNewB, reopenB, reopenFile)
  const recordNoteEl = make('div', { className: 'facts' })
  recordNoteEl.dataset.editor = 'record-note'
  const sharedEl = make('div', { className: 'facts' })
  sharedEl.dataset.editor = 'shared'
  const linkIn = tip(make('input', { type: 'text', readOnly: true }), 'link')
  linkIn.style.cssText =
    'width:100%;box-sizing:border-box;background:#0c1520;color:#9fb0c0;border:1px solid #33475c;border-radius:5px;padding:3px 6px;font:11px ui-monospace,monospace'
  const draftsSelect = tip(make('select'), 'drafts')
  draftsSelect.dataset.editor = 'drafts'
  draftsSelect.addEventListener('change', () => {
    const slot = draftsSelect.value
    draftsSelect.value = ''
    if (slot) actions.openDraft(slot)
  })
  const remixSelect = tip(make('select'), 'remix')
  remixSelect.addEventListener('change', () => {
    const id = remixSelect.value
    remixSelect.value = ''
    if (id) actions.remix(id)
  })

  // ── DEV-878: the top bar, the view's own controls and the keys sheet ────
  //
  // The same controls with the same `data-editor` names and handlers, moved:
  // the verbs a person uses every minute to a bar that never scrolls, the
  // tools onto the view, the camera buttons to its corner, the key table
  // behind "?" and the problems where the refusal line was.
  const bar = make('header', { id: 'editor-topbar' })
  bar.dataset.editor = 'topbar'
  isolateTextEntryKeys(bar)
  const toolStrip = make(
    'div',
    { id: 'editor-tools' },
    make('div', { className: 'tools' }, ...toolBs),
    toolNoteEl,
  )
  const viewCorner = make('div', { id: 'editor-view' })

  /** Every popover that is open closes when another opens, or on a press outside, or Esc. */
  const pops: { readonly pop: HTMLElement; readonly trigger: HTMLElement }[] = []
  const setOpen = (p: (typeof pops)[number], on: boolean): void => {
    p.pop.hidden = !on
    p.trigger.setAttribute('aria-expanded', String(on))
  }
  const closePops = (except?: HTMLElement): void => {
    for (const p of pops) if (p.pop !== except) setOpen(p, false)
  }
  const popover = (trigger: HTMLElement, pop: HTMLElement): void => {
    pop.hidden = true
    pop.classList.add('pop')
    trigger.setAttribute('aria-haspopup', 'true')
    trigger.setAttribute('aria-expanded', 'false')
    const p = { pop, trigger }
    pops.push(p)
    trigger.addEventListener('click', () => {
      const on = Boolean(pop.hidden)
      closePops(pop)
      setOpen(p, on)
    })
  }
  const onPressOutside = (e: PointerEvent): void => {
    const path = e.composedPath()
    for (const p of pops) {
      if (!p.pop.hidden && !path.includes(p.pop) && !path.includes(p.trigger)) setOpen(p, false)
    }
  }
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && pops.some((p) => !p.pop.hidden)) closePops()
  }
  document.addEventListener('pointerdown', onPressOutside, true)
  document.addEventListener('keydown', onEscape)

  // The problems pill, and its popover: why Fly and Share are refused, each
  // problem with the fix that was always beside it.
  const problemsB = button('problems', 'No problems', () => {}, 'pill')
  problemsB.dataset.state = 'ok'
  const problemsPop = make(
    'div',
    {},
    make('div', { className: 'head', textContent: 'PROBLEMS' }),
    refusalEl,
    warningList,
    problemsNone,
    make('div', { className: 'buttons' }, liftB),
  )
  problemsPop.dataset.editor = 'problems-pop'
  popover(problemsB, problemsPop)

  // The Share menu: what leaves this course (link, file), and the doors to
  // another one (new, remix). The trigger is never greyed, because New course
  // and Remix are how a person gets OUT of a refused course; Copy link and
  // Save file inside it are greyed with Fly.
  const shareB = button('share', 'Share', () => {}, '')
  shareB.append(' ▾')
  const devSlot = make('div', { className: 'devslot' })
  devSlot.dataset.editor = 'share-dev'
  const newB = button(
    'new',
    'New course',
    () => {
      closePops()
      actions.newCourse()
    },
    '',
  )
  remixSelect.addEventListener('change', () => closePops())
  draftsSelect.addEventListener('change', () => closePops())
  const sharePop = make(
    'div',
    {},
    make('div', { className: 'buttons' }, copyB, saveB),
    sharedEl,
    linkIn,
    make('hr'),
    make('div', { className: 'buttons' }, newB),
    row('Remix', remixSelect),
    row('Drafts', draftsSelect),
    devSlot,
  )
  sharePop.dataset.editor = 'share-menu'
  isolateTextEntryKeys(sharePop)
  popover(shareB, sharePop)

  bar.append(
    button('leave', 'Back to hangar', actions.leave, 'back'),
    nameEl,
    button('reroll', 'Reroll', actions.reroll),
    make('div', { className: 'spacer' }),
    undoB,
    redoB,
    make('div', { className: 'menu' }, problemsB, problemsPop),
    flyB,
    make('div', { className: 'menu' }, shareB, sharePop),
  )

  // The key table, printed from the one list, behind the corner's "?".
  // `data-editor="controls"` names the table, as it named the old folded list.
  const keysTable = (() => {
    const rows: HTMLElement[] = []
    let group = ''
    for (const k of DESK_KEY_LIST) {
      if (k.group !== group) {
        group = k.group
        rows.push(make('tr', {}, make('th', { colSpan: 2, textContent: k.group })))
      }
      rows.push(
        make('tr', {}, make('td', { textContent: k.keys }), make('td', { textContent: k.does })),
      )
    }
    const table = make('table', {}, make('tbody', {}, ...rows))
    table.dataset.editor = 'controls'
    return table
  })()
  const keysB = button('keys', '?', () => {})
  keysB.setAttribute('aria-label', 'Keys and mouse')
  const keysClose = button('keys-close', 'Close', () => closePops())
  const keysSheet = make(
    'div',
    { id: 'editor-keys' },
    make('div', { className: 'head' }, make('span', { textContent: 'KEYS AND MOUSE' }), keysClose),
    keysTable,
  )
  keysSheet.dataset.editor = 'keys-sheet'
  popover(keysB, keysSheet)
  viewCorner.append(topB, frameB, keysB)

  // ── the inspector: Course, Props, World, in that order, as headings ─────
  const section = (name: string, title: string): HTMLElement => {
    const h = make('h3', { className: 'section', textContent: title })
    h.dataset.editor = `section-${name}`
    return h
  }
  el.append(
    section('course', 'COURSE'),
    // DEV-473: the gap, the finish and the heights, as a person reads them.
    make(
      'div',
      { className: 'group' },
      make('div', { className: 'head', textContent: 'Ring gap', title: PANEL_TIPS['gap-slider'] }),
      make('div', { className: 'row' }, gapSlider, gapIn, make('span', { textContent: 'm' })),
      gapReadout,
    ),
    row('Time limit (s)', timeIn),
    make(
      'div',
      { className: 'sentence', title: PANEL_TIPS.height },
      make('span', { textContent: 'New points are placed' }),
      heightIn,
      make('span', { textContent: 'm above the ground' }),
    ),
    pointHeightRow,
    // DEV-475: the start pad, where the Start slider was.
    make(
      'div',
      { className: 'group' },
      make('div', { className: 'head', textContent: 'Start pad', title: PANEL_TIPS.pad }),
      make('div', { className: 'buttons' }, padB, padRotateB),
      anchoredNote,
      padTurnNoteEl, // DEV-501 follow-up
      make('div', { className: 'buttons' }, anchorB),
      make(
        'div',
        { className: 'sentence', title: PANEL_TIPS['pad-yaw'] },
        make('span', { textContent: 'The ship faces' }),
        padYawIn,
        make('span', { textContent: 'degrees' }),
      ),
    ),
    make(
      'div',
      { className: 'group' },
      make('div', {
        className: 'head',
        textContent: 'Finish: how far along the line',
        title: PANEL_TIPS.finish,
      }),
      finishIn,
      finishReadoutEl,
    ),
    make('div', { className: 'buttons' }, deleteB, flyHereB),
    make('div', { className: 'buttons' }, recordB), // DEV-491
    recordNoteEl, // DEV-491
    facts,
    section('props', 'PROPS'),
    propGroup.element, // DEV-504: the prop library, folded shut until used
    section('world', 'WORLD'),
    row('Base', skySelect), // DEV-499: Matt, "change 'sky' to 'base'"
    row('Water', waterOn), // DEV-500
    row('Water level', waterSlider),
    waterReadout,
    lightGroup.element, // DEV-476: the sun and the tint, folded shut
    make('div', { className: 'buttons' }, islandB, seedB), // DEV-490, DEV-493
    islandTroubleEl, // DEV-490
    lostRow, // DEV-499
  )
  document.body.append(bar, toolStrip, viewCorner, keysSheet)
  document.body.appendChild(el)

  /**
   * DEV-473's controls: write unless a number is mid-typing. A committed field
   * shows the draft's clamped value even while it keeps the focus, and a
   * slider being dragged shows the value the draft took (the finish stops at
   * the start rather than passing it).
   */
  const show = (input: HTMLInputElement, v: string): void => {
    if (!typing.has(input) && input.value !== v) input.value = v
  }

  return {
    element: el,
    devSlot,
    render(s) {
      nameEl.textContent = `${s.name}`
      if (skySelect.options.length !== s.skies.length) {
        // DEV-875: grouped by place, so a base on another island is reachable.
        const groups = new Map<string, HTMLElement[]>()
        for (const k of s.skies) {
          const g = groups.get(k.place ?? '') ?? []
          g.push(make('option', { value: k.id, textContent: k.title }))
          groups.set(k.place ?? '', g)
        }
        skySelect.replaceChildren(
          ...[...groups].flatMap(([place, options]) =>
            place === '' || groups.size === 1
              ? options
              : [make('optgroup', { label: place }, ...options)],
          ),
        )
      }
      if (skySelect.value !== s.sky) skySelect.value = s.sky
      skySelect.disabled = s.busy
      // DEV-500
      waterOn.checked = s.water.y !== null
      waterOn.disabled = s.busy || s.water.own === true
      waterSlider.min = String(Math.floor(s.water.min))
      waterSlider.max = String(Math.ceil(s.water.max))
      waterSlider.disabled = s.busy || s.water.y === null
      if (s.water.y !== null && document.activeElement !== waterSlider) {
        waterSlider.value = String(Math.round(s.water.y))
      }
      waterReadout.textContent =
        s.water.y === null
          ? 'No water of the course’s own'
          : `The water stands at ${Math.round(s.water.y)} m`
      const remixKey = s.library.map((e) => e.id).join(',')
      if (remixSelect.dataset.key !== remixKey) {
        remixSelect.dataset.key = remixKey
        remixSelect.replaceChildren(
          make('option', {
            value: '',
            textContent: s.library.length ? 'a course you keep…' : 'no courses kept yet',
          }),
          ...s.library.map((e) => make('option', { value: e.id, textContent: e.name })),
        )
      }
      remixSelect.disabled = s.busy || s.library.length === 0
      // DEV-889: the shelf of recent drafts.
      const draftsKey = s.drafts.map((d) => `${d.slot}=${d.label}`).join('|')
      if (draftsSelect.dataset.key !== draftsKey) {
        draftsSelect.dataset.key = draftsKey
        draftsSelect.replaceChildren(
          make('option', {
            value: '',
            textContent: s.drafts.length ? 'a recent draft…' : 'no other drafts',
          }),
          ...s.drafts.map((d) => make('option', { value: d.slot, textContent: d.label })),
        )
      }
      draftsSelect.disabled = s.busy || s.drafts.length === 0
      saveB.disabled = !s.canFly || s.busy
      copyB.disabled = !s.canFly || s.busy
      // DEV-878: a refused course says why on the greyed buttons themselves.
      const why = s.refusal.length > 0 ? refusalReadout(s.refusal) : ''
      flyB.title = why || PANEL_TIPS.fly
      saveB.title = why || PANEL_TIPS['save-file']
      copyB.title = why || PANEL_TIPS['copy-link']
      const errors = s.warnings.filter((w) => w.severity === 'error').length
      const cautions = s.warnings.filter((w) => w.severity === 'warning').length
      const problems = errors + cautions
      problemsB.textContent =
        problems === 0 ? 'No problems' : `${problems} problem${problems === 1 ? '' : 's'}`
      problemsB.dataset.state = errors > 0 ? 'error' : cautions > 0 ? 'warning' : 'ok'
      problemsNone.style.display = s.warnings.length === 0 ? '' : 'none'
      sharedEl.textContent = s.shared
      if (linkIn.value !== s.link) linkIn.value = s.link
      linkIn.style.display = s.link ? '' : 'none'
      el.dataset.link = s.link
      show(gapSlider, String(s.gap))
      show(gapIn, String(s.gap))
      gapReadout.textContent = ringsReadout(s.rings, s.lineLength)
      show(timeIn, String(s.timeLimit))
      show(heightIn, String(Math.round(s.placeHeight)))
      pointHeightRow.style.display = s.selectedHeight === null ? 'none' : ''
      pointHeightLead.textContent = `Selected point ${(s.selection ?? 0) + 1}:`
      if (s.selectedHeight !== null) show(pointHeightIn, String(Math.round(s.selectedHeight)))
      show(padYawIn, String(s.padYaw))
      padB.textContent = s.padPicked ? 'Done' : 'Move pad'
      padRotateB.textContent = s.padPicked && s.padRotate ? 'Move pad' : 'Aim pad'
      padB.disabled = s.busy
      padRotateB.disabled = s.busy
      anchoredNote.style.display = s.anchored ? '' : 'none'
      padTurnNoteEl.textContent = s.padTurnNote // DEV-501 follow-up
      padTurnNoteEl.style.display = s.padTurnNote ? '' : 'none'
      anchorB.style.display = s.anchored ? 'none' : ''
      anchorB.disabled = s.busy
      el.dataset.pad = s.padPicked ? (s.padRotate ? 'aim' : 'move') : ''
      // DEV-570
      for (const b of toolBs) b.classList.toggle('on', b.dataset.tool === s.tool)
      toolNoteEl.textContent = s.toolNote
      el.dataset.tool = s.tool
      show(finishIn, String(s.finish))
      finishReadoutEl.textContent = finishReadout(s.finish, s.lineLength)
      lightGroup.render(s.light) // DEV-476
      propGroup.render(s.props) // DEV-504
      gapSlider.disabled = s.busy
      finishIn.disabled = s.busy
      undoB.disabled = !s.canUndo || s.busy
      redoB.disabled = !s.canRedo || s.busy
      deleteB.disabled = s.selection === null || s.busy
      topB.textContent = s.topDown ? 'Orbit' : 'Top-down'
      flyB.disabled = !s.canFly || s.busy
      flyHereB.disabled = !s.canFly || s.selection === null || s.busy
      refusalEl.textContent = refusalLead(s.refusal)
      liftB.disabled = !s.canLift || s.busy
      // DEV-491
      recordB.disabled = !s.canRecord || s.busy
      recordNoteEl.textContent = s.recordNote
      recordNoteEl.style.display = s.recordNote ? '' : 'none'
      frameB.disabled = s.busy
      islandB.disabled = s.busy // DEV-490
      seedB.disabled = s.busy // DEV-493
      islandTroubleEl.textContent = s.islandTrouble
      lostRow.style.display = s.islandLost ? '' : 'none' // DEV-499
      lostNewB.disabled = s.busy
      reopenB.disabled = s.busy
      facts.replaceChildren(
        make('div', {
          textContent: `${s.island} · ${s.points} point${s.points === 1 ? '' : 's'} · ${
            s.rings === null ? 'no rings yet' : `${s.rings} ring${s.rings === 1 ? '' : 's'}`
          }`,
        }),
        make('div', { textContent: s.courseId ?? '' }),
        make('div', {
          textContent:
            s.authorLap === null
              ? 'No author lap yet: fly it from the start and take every ring.'
              : `Author lap ${s.authorLap.toFixed(2)} s`,
        }),
        ...(s.remixedFrom ? [make('div', { textContent: `Remixed from ${s.remixedFrom}` })] : []),
      )
      el.dataset.courseId = s.courseId ?? ''
      el.dataset.points = String(s.points)
      el.dataset.rings = s.rings === null ? '' : String(s.rings)
      el.dataset.selection = s.selection === null ? '' : String(s.selection)
      el.dataset.authorLap = s.authorLap === null ? '' : String(s.authorLap)
      warningList.replaceChildren(
        ...s.warnings.map((w) => {
          const li = make('li', { className: w.severity, textContent: w.message })
          // DEV-486: the fix beside the warning it answers.
          if (w.fix) {
            const runout = w.fixKind === 'runout'
            const fix = button(
              runout ? 'runout-fix' : 'run-in-fix',
              w.fix,
              runout ? actions.extendRunout : actions.straighten,
            )
            fix.disabled = s.busy
            fix.style.cssText = 'display:block;margin:4px 0 2px;font-size:12px;padding:3px 8px'
            li.append(fix)
          }
          return li
        }),
      )
    },
    setVisible(on) {
      for (const node of [el, bar, toolStrip, viewCorner]) node.style.display = on ? '' : 'none'
      if (!on) closePops()
    },
    dispose() {
      document.removeEventListener('pointerdown', onPressOutside, true)
      document.removeEventListener('keydown', onEscape)
      for (const node of [el, bar, toolStrip, viewCorner, keysSheet]) node.remove()
      style.remove()
    },
  }
}
