// src/input/escape-pause.ts: what one frame's pause controls do to `paused`.
// DEV-563.
//
// Matt, 2026-10-01: Escape opens the pause menu in flight. Pause was Backspace
// (2016's own key) and Escape was deliberately unbound, because the browser
// owns it. It still does, so Escape reaches the game in one of two forms and
// never both:
//
//   - the pointer is CAPTURED: Chrome spends the key on letting go and the page
//     sees only the capture ending (`look.ts`'s `readLostCapture`);
//   - the pointer is FREE: an ordinary keydown (`keyboard.ts`'s `escape`, which
//     refuses a press that arrives while captured, so a browser that delivers
//     both cannot hand the game one press twice).
//
// The two forms are not the same verb. A lost capture only ever OPENS: it can
// arrive while the menu is already up (the plate is aimed with the captured
// mouse, so a player reading it holds the pointer), and an Escape that closed
// the menu would be the browser's key deciding the game's state on its own.
// A free Escape TOGGLES, as Backspace does, so Escape then Escape is open then
// closed, which is what the key does in every menu on a desktop.
//
// No three.js and no DOM, so the whole rule is a table a unit test can read.

/** One frame's pause controls, each already edge-detected by the caller. */
export interface PauseSignals {
  /** The pause control went down this frame: Backspace, Start, the touch button, the XR D-pad. */
  readonly toggle: boolean
  /** Escape went down this frame with the pointer free. */
  readonly escape: boolean
  /** The player let go of a captured pointer since the last frame. */
  readonly lostCapture: boolean
  /**
   * Escape only frees the pointer: the `?lookdev=1` panel is open (Matt,
   * 2026-10-01: freeing the pointer to use the tuning panel must not open the
   * pause menu). Both of Escape's forms are then the browser's alone; the
   * pause control (Backspace and the rest) still toggles.
   */
  readonly escapeFreesOnly?: boolean
  /**
   * DEV-566: a screen stands over the game (a phone held upright,
   * `turn-phone.ts`). A LEVEL, not an edge: the run is paused on every frame
   * it stands, whatever else was pressed, and it only ever opens. When it goes
   * the menu stays up, so the run waits for the player's RESUME rather than
   * flying on the moment the phone comes round.
   */
  readonly held?: boolean
}

/**
 * The pause state after this frame's controls, for a run that MAY pause (the
 * caller's gate: a live mission, not dying, not the results panel).
 *
 * Two toggles in one frame are one press, not two that cancel: Backspace and
 * Escape held together pause once. A lost capture wins over both, so the menu
 * is up after any frame the pointer left in.
 */
export const nextPaused = (paused: boolean, s: PauseSignals): boolean => {
  if (s.held === true) return true
  const escapeCounts = s.escapeFreesOnly !== true
  if (s.lostCapture && escapeCounts) return true
  return s.toggle || (s.escape && escapeCounts) ? !paused : paused
}
