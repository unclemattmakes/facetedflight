// src/content/ui-strings.ts — 2016's own UI copy, and every change we make to it.
//
// ── Why this file exists ─────────────────────────────────────────────────
//
// Until `tools/extract/ui-text.mjs` landed, every string the port showed was a
// literal in `src/render/**` or `src/boot/app.ts`, copied out of a Unity prefab
// by eye with the prefab line in the comment above it. That is hand-typing a
// constant (CLAUDE.md hard rule 3), and it was wrong in exactly the ways
// hand-typed constants are wrong: the briefing's apostrophe had been normalised
// from U+0027 to U+2019 and its trailing newline dropped, and the speed label —
// `SPEED:` in the port — is neither of the two things 2016 actually writes.
//
// `level.ui.strings` carries the real bytes now. This module is the ONE place
// that turns them into what FF2 draws, so that every difference is a named
// function with a reason rather than a literal somebody retyped.
//
// ── The fallbacks are not decoration ─────────────────────────────────────
//
// Each reader takes a fallback, and the fallback is the word FF2 chooses when
// 2016 has no string for that row at all. That is a real case and not a
// defensive habit: the JumpSeat's `ui.strings` set carries a fuel gauge and no
// gate or orb label, because `HUD_Gameplay.UpdateUI()` is commented out end to
// end (`:56-83`) and the in-mission JumpSeat HUD showed no live count. Where a
// fallback is used, the word is FF2's and `tests/unit/extract-ui-strings.test.ts`
// pins it so it cannot drift away from the extracted string it stands in for.
//
// ── The transforms ARE the deviations ────────────────────────────────────
//
// `label()` upper-cases and strips the colon, because the panels draw their own
// separators and 2016's sentence case does not survive at 14 px on a curved
// surface in a headset. That is a decision, it applies to every instrument row,
// and it is written once here rather than eleven times at eleven call sites.
//
// Everything else is `identity`, deliberately. 2016's punctuation is kept
// exactly, warts included — `- PAUSE -` with its spaces, `Powering On...` with
// three dots, and the briefing's trailing newline.
//
// CONTENT IS DATA (hard rule 6): a mission with different copy is a different
// JSON file, never a different branch in `src/`.

import type { Level } from './level-schema'

/** A mission's strings, or an empty set for a level built before `ui` existed. */
const strings = (level: Level): Record<string, string> => level.ui?.strings ?? {}

/**
 * One string, or the fallback when this vehicle's HUD has no such row.
 *
 * An empty string counts as absent. 2016 ships no empty ones — the extractor's
 * own test asserts every value has length — so an empty here means something
 * upstream produced a blank, and falling back is better than drawing nothing.
 */
export const uiString = (level: Level, key: string, fallback: string): string => {
  const found = strings(level)[key]
  return found === undefined || found.length === 0 ? fallback : found
}

/**
 * An instrument LABEL: upper-cased, with 2016's trailing colon removed.
 *
 * `Gates:` -> `GATES`, `Speed :` -> `SPEED`. The panels append their own
 * separator, so a colon carried through would double it, and the space before
 * the colon on `Speed :` — which 2016 has on that one label and no other, and
 * disagrees with itself about (the third-person console says `SpeeD :`) — goes
 * with it.
 */
export const uiLabel = (level: Level, key: string, fallback: string): string =>
  uiString(level, key, fallback).replace(/\s*:$/, '').toUpperCase()

/**
 * The first WORD of a label, upper-cased.
 *
 * For the rows where 2016 writes a phrase and the panel has room for a word:
 * `Orbs FounD:` -> `ORBS`, `Gates cleared:` -> `GATES`. It also drops the stray
 * capital D that runs through 2016's HUD copy, which is kept everywhere it is
 * READ as a sentence (`Exploration EnDing...`, `________ medal AwarDeD!`) and
 * dropped where the string is being used as a column heading.
 */
export const uiLabelWord = (level: Level, key: string, fallback: string): string => {
  const first = uiString(level, key, fallback).split(' ')[0] ?? fallback
  return first.replace(/\s*:$/, '').toUpperCase()
}

/**
 * The mission briefing, verbatim.
 *
 * **Ends in a newline**, and the apostrophe in `Don't` is U+0027. Both are in
 * the shipped bytes; both were wrong in the literal this replaces.
 */
export const uiBriefing = (level: Level, fallback: string): string => {
  const text = level.ui?.briefing
  return text === undefined || text.length === 0 ? fallback : text
}
