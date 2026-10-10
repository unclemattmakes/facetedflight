// Type declarations for ui-text.mjs, kept separate for the same reason
// `tools/terrain/png.d.mts` is: the extractors are plain ESM JavaScript that
// Node runs directly, and only the handful of exports a Vitest test touches
// need types. Adding a build step to the extract pipeline to get them would be
// a worse trade.

/** One `UnityEngine.UI.Text` found in a prefab, with its string. */
export interface UiTextRow {
  readonly path: string
  readonly name: string
  /** Which HUD the label belongs to. The two disagree — see `ui-text.mjs`. */
  readonly hud: 'firstPerson' | 'thirdPerson' | 'other'
  readonly live: boolean
  readonly enabled: boolean
  /** Null when the raw scan found no `m_Text` for this component — a reader bug. */
  readonly text: string | null
  readonly fileID: string
  readonly line: number | null
}

/** Every `m_Text` in a Unity YAML file, keyed by its MonoBehaviour's fileID. */
export declare const rawTextsByFileId: (
  absPath: string,
) => Map<string, { text: string; line: number }>

/**
 * One YAML scalar, starting at the text after `key: ` on line `i` of `lines`.
 * Returns the decoded value and the index of the last line consumed. Handles
 * plain, single-quoted, double-quoted and multi-line flow-folded scalars.
 */
export declare const decodeScalar: (
  first: string,
  lines: readonly string[],
  i: number,
) => { value: string; next: number }

/** Every `UnityEngine.UI.Text` in a prefab, read from the raw bytes. */
export declare const readPrefabTexts: (
  absPath: string,
  flat: { objects: readonly unknown[] },
) => UiTextRow[]

/** The strings FF2 shows, and where each comes from. */
export declare const UI_STRINGS: readonly {
  readonly id: string
  readonly select: string
  readonly vehicles?: readonly string[]
  readonly occurrence?: number
  readonly ff2: string
  readonly note?: string
}[]

export declare const BRIEFING_SELECT: string

export declare const selectUiStrings: (
  rows: readonly UiTextRow[],
  vehicle: string,
  opts: { prefabRel: string },
) => {
  strings: Record<string, string>
  meta: Record<string, unknown>
  problems: string[]
}

export declare const selectBriefing: (
  rows: readonly UiTextRow[],
  opts: { prefabRel: string },
) => { text: string | null; meta: Record<string, unknown> }
