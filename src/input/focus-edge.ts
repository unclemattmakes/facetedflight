// src/input/focus-edge.ts: "the aim moved from one row to another". DEV-646.
//
// CONSULTANT-REVIEW-2026-10-05 item J: every focusable row on every menu plays
// `ui.hover` on focus, and today the title and the room pages are silent. Each
// of those menus already keeps an AIM (a row index) that the keyboard, the pad,
// the gaze and the mouse all write, so the click hangs off the one number rather
// than off four input paths: "the aim changed".
//
// The rule is the pause's own (`audioPauseAim` in `boot/app.ts`): a click on a
// CHANGE of row, never on a held aim ("a held gaze is one hover, not eighty a
// second"), and never on a menu OPENING with its first row already selected, which
// is the screen arriving and not the player moving. So: null means "this menu is
// not up" and forgets; a key after a key is a change; a key after null is a
// baseline. PURE; state per detector (trap 19).

export interface FocusEdge {
  /** One frame's aim, or null when the menu is not up. True on a change from one row to another. */
  step(key: number | string | null): boolean
  reset(): void
}

export const createFocusEdge = (): FocusEdge => {
  let last: number | string | null = null
  return {
    step(key) {
      const changed = key !== null && last !== null && key !== last
      last = key
      return changed
    },
    reset() {
      last = null
    },
  }
}
