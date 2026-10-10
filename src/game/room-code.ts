// src/game/room-code.ts — typing a room's short code on a letter plate. DEV-441b.
//
// Matt, 2026-09-27: *"i don't really see how to start a multiplayer game."*
// A link is one way into a friend's room (DEV-389), and in a headset it is a
// poor one: the friend has to get a URL into YOUR browser. A short code is the
// other — read off their plate, typed on yours (plan/MULTIPLAYER.md §5.4, §6.9).
//
// The code IS the room's id (`net/room-protocol.ts`, `ROOM_CODE_ALPHABET`), so
// this file is only the keys: where each one sits on the plate, which one a
// stick step lands on, and what a press of each does to what is typed. Pure,
// so every rule here is a node test; `render/room-code-plate.ts` draws the
// keys and aims a ray at them, and `boot/app.ts` presses them.
//
// ── The layout ────────────────────────────────────────────────────────────
//
// Seven columns: the 28 characters in four rows of seven, digits first (as a
// phone's keypad reads), then one row of three wide keys — BACK, DELETE, JOIN.
// Wide keys are a bigger target for a head, and JOIN is widest because it is
// the one press everything else leads to.

import { MENU_NUDGE_DEADBAND, menuNudge } from '@/input/actions'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@/net/room-protocol'

/** The actions that are not characters. `boot/app.ts` switches on these. */
export const CODE_ACTION = { back: 'back', del: 'del', join: 'join' } as const

export interface CodeKey {
  /** A character's own letter, or a `CODE_ACTION`. */
  readonly id: string
  /** What the key says. */
  readonly label: string
  /** The column it starts in, and how many it covers. */
  readonly col: number
  readonly span: number
  readonly row: number
  /** The character it types, or null for an action. */
  readonly char: string | null
}

/** Columns on the plate. */
export const CODE_COLS = 7

const charKeys: CodeKey[] = Array.from(ROOM_CODE_ALPHABET, (char, i) => ({
  id: char,
  label: char,
  col: i % CODE_COLS,
  span: 1,
  row: Math.floor(i / CODE_COLS),
  char,
}))
const actionRow = Math.ceil(ROOM_CODE_ALPHABET.length / CODE_COLS)

/** Every key, characters first, in reading order. */
export const CODE_KEYS: readonly CodeKey[] = [
  ...charKeys,
  { id: CODE_ACTION.back, label: 'Back', col: 0, span: 2, row: actionRow, char: null },
  { id: CODE_ACTION.del, label: 'Delete', col: 2, span: 2, row: actionRow, char: null },
  { id: CODE_ACTION.join, label: 'Join', col: 4, span: 3, row: actionRow, char: null },
]

/** Rows on the plate. */
export const CODE_ROWS = actionRow + 1

/** The key covering cell (`col`, `row`), as an index into `CODE_KEYS`, or −1. */
export const codeKeyAt = (col: number, row: number): number =>
  CODE_KEYS.findIndex((k) => k.row === row && col >= k.col && col < k.col + k.span)

/** The index of the key named `id`. */
export const codeKeyIndex = (id: string): number => CODE_KEYS.findIndex((k) => k.id === id)

/**
 * One stick step from key `index`: `dCol` across, `dRow` down (−1 is up). Held
 * at the plate's edges, never wrapping — a wrap is a surprise on a plate you
 * are steering by feel. Up or down from a wide key leaves from its middle, so
 * JOIN's up lands over its own centre rather than on its left end.
 */
export const codeKeyStep = (index: number, dCol: number, dRow: number): number => {
  const k = CODE_KEYS[index]
  if (!k) return 0
  if (dRow !== 0) {
    const row = Math.max(0, Math.min(CODE_ROWS - 1, k.row + dRow))
    const col = k.col + Math.floor((k.span - 1) / 2)
    const at = codeKeyAt(col, row)
    return at >= 0 ? at : index
  }
  if (dCol !== 0) {
    const col = dCol < 0 ? k.col - 1 : k.col + k.span
    if (col < 0 || col >= CODE_COLS) return index
    const at = codeKeyAt(col, k.row)
    return at >= 0 ? at : index
  }
  return index
}

/**
 * A stick's step on the plate: rows from the pitch axis through the one
 * `menuNudge` every plate reads (so the invert preference moves this one as
 * it moves the rest, DEV-071), and columns from the roll axis, where `+roll`
 * is the stick to the LEFT (`input/keyboard.ts`, measured). One axis a step:
 * the larger deflection wins, so a stick pushed off-diagonal does not jump
 * two keys at once.
 */
export const codeStickStep = (
  pitch: number,
  roll: number,
  invertPitch: boolean,
): { readonly dCol: -1 | 0 | 1; readonly dRow: -1 | 0 | 1 } => {
  const dRow = menuNudge(pitch, invertPitch)
  const dCol = roll > MENU_NUDGE_DEADBAND ? -1 : roll < -MENU_NUDGE_DEADBAND ? 1 : 0
  if (dRow !== 0 && dCol !== 0) {
    return Math.abs(pitch) >= Math.abs(roll) ? { dCol: 0, dRow } : { dCol, dRow: 0 }
  }
  return { dCol, dRow }
}

/** An arrow key's step on the plate (`KeyboardEvent.key`), or null for any other key. */
export const codeArrowStep = (
  key: string,
): { readonly dCol: -1 | 0 | 1; readonly dRow: -1 | 0 | 1 } | null => {
  switch (key) {
    case 'ArrowUp':
      return { dCol: 0, dRow: -1 }
    case 'ArrowDown':
      return { dCol: 0, dRow: 1 }
    case 'ArrowLeft':
      return { dCol: -1, dRow: 0 }
    case 'ArrowRight':
      return { dCol: 1, dRow: 0 }
    default:
      return null
  }
}

/** What a press did, besides changing what is typed. */
export type CodeOutcome = 'typed' | 'deleted' | 'join' | 'back' | 'nothing'

/**
 * A press of `key` with `typed` on the plate: the new text, and what it did.
 * A character past the code's length types nothing; JOIN only goes when the
 * code is whole; DELETE on nothing is BACK, so a plate typed empty is one
 * press from where it came — the keyboard's Backspace reads the same way.
 */
export const pressCodeKey = (
  typed: string,
  key: CodeKey,
): { readonly typed: string; readonly outcome: CodeOutcome } => {
  if (key.char !== null) {
    return typed.length < ROOM_CODE_LENGTH
      ? { typed: typed + key.char, outcome: 'typed' }
      : { typed, outcome: 'nothing' }
  }
  switch (key.id) {
    case CODE_ACTION.del:
      return typed.length > 0
        ? { typed: typed.slice(0, -1), outcome: 'deleted' }
        : { typed, outcome: 'back' }
    case CODE_ACTION.join:
      return { typed, outcome: typed.length === ROOM_CODE_LENGTH ? 'join' : 'nothing' }
    case CODE_ACTION.back:
      return { typed, outcome: 'back' }
    default:
      return { typed, outcome: 'nothing' }
  }
}

/**
 * A keyboard's key, as the plate reads it: `KeyboardEvent.key`, so a layout's
 * own letters. A character of the alphabet in either case is that key; any
 * other printable character is nothing (an O is not quietly a zero), and
 * Backspace is DELETE. Null for everything else, which the plate leaves to the
 * rest of the game: Enter is the confirm every plate reads (it presses the key
 * the plate is aimed at, and a whole code moves the aim to JOIN), and the
 * arrow keys steer.
 */
export const codeKeyForKeyboard = (key: string): CodeKey | null => {
  if (key === 'Backspace') return CODE_KEYS[codeKeyIndex(CODE_ACTION.del)] ?? null
  if (key.length !== 1) return null
  const i = codeKeyIndex(key.toUpperCase())
  return i >= 0 && (CODE_KEYS[i]?.char ?? null) !== null ? (CODE_KEYS[i] ?? null) : null
}

/**
 * The typed code as the plate shows it: the characters so far, a blank for
 * each still to come, as a three and a four (`K7Q X4__`, DEV-458: seven
 * characters, grouped as a phone number is) — the way a person reads one
 * aloud.
 */
export const codeTypedText = (typed: string): string => {
  const cells = Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => typed.charAt(i) || '_')
  const half = Math.floor(ROOM_CODE_LENGTH / 2)
  return `${cells.slice(0, half).join('')} ${cells.slice(half).join('')}`
}

/** A whole code as a lobby plate says it: the same three and four, nothing blank. */
export const roomCodeSpoken = (code: string): string => codeTypedText(code)

// ── DEV-632: a code that arrives whole (a paste, a phone's own keyboard) ─────
//
// Matt, 2026-10-04: *"typing a room code on mobile is painful, same with PC."*
// A keyboard's paste and a phone's text field both hand the plate a STRING,
// which may be the code as a friend sent it (`K7Q X4MN`, lower case, with a
// dash), or the whole invite link (`https://.../?room=K7QX4MN`). These read it.

/** The `room` parameter of a link anywhere in `text`, or null. */
const linkRoom = (text: string): string | null => {
  const m = /[?&#]room=([^&#\s]+)/i.exec(text)
  if (m?.[1] === undefined) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

/**
 * What a phone's text field holds, as the plate takes it: a link's code if
 * the text carries one, then the alphabet's characters in either case and
 * nothing else (an O is not quietly a zero, `codeKeyForKeyboard`'s rule), at
 * most a code's length. The field shows this back, so a refused character
 * simply does not appear.
 */
export const codeCharsOf = (text: string): string => {
  const source = linkRoom(text) ?? text
  let out = ''
  for (const c of source.toUpperCase()) {
    if (out.length >= ROOM_CODE_LENGTH) break
    if (ROOM_CODE_ALPHABET.includes(c)) out += c
  }
  return out
}

/**
 * A PASTE on the plate: the code it carries, or null when it carries none. A
 * link's `room`, or the text itself, with the spaces, dashes and dots a code is
 * written with taken out; then every character must be the alphabet's and
 * there must be at most a code's length of them. Stricter than a phone's field,
 * because a paste is one act: a paragraph that happens to contain capitals is
 * not seven of them typed.
 */
export const codeFromPaste = (text: string): string | null => {
  const source = (linkRoom(text) ?? text)
    .trim()
    .toUpperCase()
    .replace(/[\s.\-_]/g, '')
  if (source.length === 0 || source.length > ROOM_CODE_LENGTH) return null
  for (const c of source) if (!ROOM_CODE_ALPHABET.includes(c)) return null
  return source
}
