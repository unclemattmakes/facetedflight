// src/game/ghost-store.ts — your best lap, kept on this device. DEV-371.
//
// `game/personal-best.ts` keeps the best SCORE; this keeps the best LAP, the
// poses, so the next run can fly against it (`PLAYER-GHOSTS.md` §5, §8 call 8:
// your own best lap is on by default). Nothing leaves the browser: sharing is
// DEV-373's, and explicit.
//
// ── Wrapped exactly as `personal-best.ts` is, and for its reasons ────────
//
// `localStorage` THROWS on access in a private window with site data blocked
// and in some webviews, so every read and write is inside a try, and the
// storage is injectable so the tests can hand in one that throws. The key is
// visible in devtools on a public URL, so anything read back is checked before
// it is believed: a value that is not a lap this key could hold is ABSENT.
//
// ── What is stored ───────────────────────────────────────────────────────
//
// One JSON object per `(mission, mode, edition)` (and variant, past
// `standard`: see `ghostKey`): the lap as base64url of the
// `ff2-ghost-2` WIRE (`sim/ghost-record.ts`'s `lapToBytes`), plus the result it
// was kept for and whether it was tainted. Not deflated: `CompressionStream` is
// asynchronous and a lap is ~17 KB raw (~23 KB as text), so a key per course
// per edition is well inside any origin's quota. A deflated form is DEV-373's to
// choose for the wire it sends.
//
// ── Which lap is "best" ──────────────────────────────────────────────────
//
// A CLEAN lap beats a tainted one whatever the clock says, because "your best"
// means the best lap YOU flew, and an autopilot's lap is not one; then more
// rings; then less time. That is the board's order (`PLAYER-GHOSTS.md` §3.5:
// rings, then time) with taint in front of it. A tie is not an improvement,
// for `personal-best.ts`'s reason.

import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { fromBase64url, toBase64url } from '@/net/base64url'
import { LAP_SCHEMA, type LapDoc } from '@/sim/ghost'
import { lapFromBytes, lapToBytes } from '@/sim/ghost-record'
import { safeStorage } from './personal-best'
import { recordingHeld } from './tv/off-the-record'

/**
 * The `.v` of the key: this STORE's format, and `bestKey`'s escape hatch
 * (`personal-best.ts`). Bump it to ignore every stored lap rather than migrate.
 *
 * It is NOT the rules version. That is the lap's own `rules`, which DEV-372's
 * `lapRules(mission, edition)` derives from the course and the edition's
 * gameplay block, so it moves by itself when a gameplay number does; a lap
 * whose `rules` are not the current ones reads as absent here (see `LapSlot`).
 */
export const GHOST_STORE_VERSION = '1'

/**
 * The `rules` of a lap on a course the lap server has no board for
 * (`lapRules` returns null: another mode, another aircraft, a course it does
 * not judge). Such a lap is kept and raced here and never submitted.
 */
export const LOCAL_LAP_RULES = 'local'

const KEY_PREFIX = 'ff2.ghost.'

/**
 * `ff2.ghost.<mission>.<mode>.<edition>.v1` — one lap per course, per mode, per
 * preset, and per aircraft VARIANT past `standard` (`...<edition>.<variant>.v1`):
 * a speed jet's lap is not the standard jet's best, and AIRCRAFT-VARIANTS §6.3
 * asks for exactly this key. `standard` keeps the plain key, so nothing kept
 * before variants existed moves.
 */
export const ghostKey = (
  mission: string,
  mode: string,
  edition: string,
  variant: string = STANDARD_VARIANT_ID,
): string =>
  `${KEY_PREFIX}${mission}.${mode}.${edition}${variant === STANDARD_VARIANT_ID ? '' : `.${variant}`}.v${GHOST_STORE_VERSION}`

/**
 * Which lap a slot holds: the key's four parts, and the two things a lap must
 * ALSO match to be raced as "your best" — the current `rules` (a lap flown
 * under other rules is not comparable, and the server would refuse it) and the
 * lap's `vehicle` (DEV-372's `lapVehicle`: `hoverjet`, or `hoverjet:speed`).
 */
export interface LapSlot {
  readonly mission: string
  readonly mode: string
  readonly edition: string
  readonly rules: string
  readonly vehicle: string
  readonly variant: string
}

/** A lap as the store holds it, once it has been checked. */
export interface StoredLap {
  readonly doc: LapDoc
  /** Mission seconds at the finish, from `scoreGhost` on the lap's own poses. */
  readonly seconds: number
  /** Rings the lap takes, by the same rescore. */
  readonly gates: number
  /** D30's `runTainted`: may be raced here and never submitted. */
  readonly tainted: boolean
  /** Why, for a person reading devtools. Display only. */
  readonly reasons: readonly string[]
  /** `Date.now()` when it was kept. Display only; never compared. */
  readonly setAt: number
}

/** A finished lap offered to the store. */
export interface LapCandidate {
  readonly doc: LapDoc
  /** Null for a lap that never crossed the finish, which is never kept. */
  readonly seconds: number | null
  readonly gates: number
  readonly tainted: boolean
  readonly reasons: readonly string[]
}

// DEV-571: `removeItem` is optional, so a test's two-method store still fits;
// without it a "no" with nothing kept before writes an empty slot instead.
type LapStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>

/** Does `a` beat `b`? See the header: clean first, then rings, then time. */
export const lapBeats = (
  a: { readonly seconds: number; readonly gates: number; readonly tainted: boolean },
  b: { readonly seconds: number; readonly gates: number; readonly tainted: boolean },
): boolean => {
  if (a.tainted !== b.tainted) return !a.tainted
  if (a.gates !== b.gates) return a.gates > b.gates
  return a.seconds < b.seconds
}

// base64url is DEV-372's codec (`net/base64url.ts`): the text a lap is kept in
// here is the text a lap travels in, one codec for both.

/** A stored value that is not a lap this slot could hold is treated as absent. */
const parse = (raw: string | null, slot: LapSlot): StoredLap | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    // `typeof`, not coercion, for `personal-best.ts`'s reason: `Number(null)`
    // is 0, and a hand-edited `"seconds": null` must not become a 0 s lap.
    const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
    if (!ok(v.seconds) || !ok(v.gates) || !Number.isInteger(v.gates)) return null
    if (typeof v.lap !== 'string') return null
    const bytes = fromBase64url(v.lap)
    if (!bytes) return null
    // Throws on bad magic, truncation, trailing bytes and a malformed doc.
    const doc = lapFromBytes(bytes)
    // A lap under another course's, mode's or preset's key is somebody else's,
    // whatever put it there. One flown under other RULES, or in another
    // aircraft, is not comparable with a lap flown now: it is not your best,
    // and the first lap you finish takes its place.
    if (
      doc.$schema !== LAP_SCHEMA ||
      doc.mission !== slot.mission ||
      doc.mode !== slot.mode ||
      doc.edition !== slot.edition ||
      doc.rules !== slot.rules ||
      doc.vehicle !== slot.vehicle
    ) {
      return null
    }
    return {
      doc,
      seconds: v.seconds,
      gates: v.gates,
      // Anything but an explicit `false` is tainted. A hand edit that wants a
      // lap to be clean has to say so in the one form this module writes, and
      // a value nobody wrote reads as the safe side.
      tainted: v.tainted !== false,
      reasons: Array.isArray(v.reasons)
        ? v.reasons.filter((r): r is string => typeof r === 'string')
        : [],
      setAt: ok(v.setAt) ? v.setAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * The kept lap for a slot, or null. Never throws.
 *
 * `storage` is injectable so the tests need no DOM and can hand in a store that
 * throws, which is the case that matters.
 */
export const readLap = (
  slot: LapSlot,
  storage: LapStorage | null = safeStorage(),
): StoredLap | null => {
  if (!storage) return null
  try {
    return parse(
      storage.getItem(ghostKey(slot.mission, slot.mode, slot.edition, slot.variant)),
      slot,
    )
  } catch {
    return null
  }
}

/**
 * Keep `lap` if it beats the one stored for its slot, and say what happened.
 *
 * - `best`: the lap the store holds after this call, or null. When the write
 *   failed (quota, a private window) that is the PREVIOUS one, because that is
 *   what the next read will return.
 * - `improved`: the lap beat what was there.
 * - `stored`: it was written. `improved && !stored` is a lap that deserved the
 *   slot and could not have it; the run still ends, and "race this lap" still
 *   has it in memory.
 *
 * The slot is the LAP's own meta (and the variant it was flown in), so a caller
 * cannot file a lap under another course, and a lap under stale rules or in
 * another aircraft is replaced by the next one rather than compared with it. A
 * lap that did not finish is never kept.
 */
export const keepLap = (
  lap: LapCandidate,
  variant: string = STANDARD_VARIANT_ID,
  storage: LapStorage | null = safeStorage(),
): { best: StoredLap | null; improved: boolean; stored: boolean } => {
  const { mission, mode, edition, rules, vehicle } = lap.doc
  const previous = readLap({ mission, mode, edition, rules, vehicle, variant }, storage)
  if (lap.seconds === null) return { best: previous, improved: false, stored: false }
  // DEV-483: while TV's exhibition holds the record doors, no lap is kept
  // (`game/tv/off-the-record.ts`).
  if (recordingHeld()) return { best: previous, improved: false, stored: false }
  // `setAt` is display only; `writeLap` stamps the one it writes.
  const candidate: StoredLap = {
    doc: lap.doc,
    seconds: lap.seconds,
    gates: lap.gates,
    tainted: lap.tainted,
    reasons: [...lap.reasons],
    setAt: Date.now(),
  }
  const improved = previous === null || lapBeats(candidate, previous)
  if (!improved || !storage) return { best: previous, improved, stored: false }
  // DEV-601: a lap the autopilot flew any of is not kept as your ghost of its
  // own accord, so the panel's SAVE AS YOUR GHOST? starts at NO for it. A press
  // still keeps it (`keepLast`): racing the autopilot's line is a fair thing to
  // want, it is only not YOUR lap unless you say so.
  if (lap.reasons.includes('autopilot')) return { best: previous, improved, stored: false }
  // Quota, a private window, a webview with storage off: the lap was flown and
  // the panel still has it; only the memory of it is lost.
  if (!writeLap(lap, variant, storage)) return { best: previous, improved, stored: false }
  return { best: candidate, improved, stored: true }
}

// ── DEV-571: the results panel ASKS ──────────────────────────────────────
//
// Matt, 2026-10-02: *"ask if they want to save their ghost"*. `keepLap` is
// still the first answer (a lap that beats the saved one is saved on the
// finish tick, so a quick retry races it, as before); the panel's question
// then moves it either way. YES writes this lap over whatever is saved,
// faster or not: it is the player's ghost, chosen. NO puts back exactly the
// text that was there before this lap, or empties the slot if there was none.

/** The slot's text as stored, or null: what a "no" puts back. Never throws. */
export const readLapText = (
  doc: Pick<LapDoc, 'mission' | 'mode' | 'edition'>,
  variant: string = STANDARD_VARIANT_ID,
  storage: LapStorage | null = safeStorage(),
): string | null => {
  if (!storage) return null
  try {
    return storage.getItem(ghostKey(doc.mission, doc.mode, doc.edition, variant))
  } catch {
    return null
  }
}

/**
 * Write `lap` to its slot whatever is there. False when it could not be
 * written: no storage, a write that threw, a lap that never finished, or TV
 * holding the record doors (DEV-483).
 */
export const writeLap = (
  lap: LapCandidate,
  variant: string = STANDARD_VARIANT_ID,
  storage: LapStorage | null = safeStorage(),
): boolean => {
  if (!storage || lap.seconds === null || recordingHeld()) return false
  const { mission, mode, edition } = lap.doc
  try {
    storage.setItem(
      ghostKey(mission, mode, edition, variant),
      JSON.stringify({
        lap: toBase64url(lapToBytes(lap.doc)),
        seconds: lap.seconds,
        gates: lap.gates,
        tainted: lap.tainted,
        reasons: [...lap.reasons],
        setAt: Date.now(),
      }),
    )
    return true
  } catch {
    return false
  }
}

/** Put a slot back as `text` had it (null: empty). False when it could not. */
export const restoreLapText = (
  doc: Pick<LapDoc, 'mission' | 'mode' | 'edition'>,
  variant: string,
  text: string | null,
  storage: LapStorage | null = safeStorage(),
): boolean => {
  if (!storage) return false
  const key = ghostKey(doc.mission, doc.mode, doc.edition, variant)
  try {
    if (text !== null) storage.setItem(key, text)
    else if (storage.removeItem) storage.removeItem(key)
    else storage.setItem(key, '')
    return true
  } catch {
    return false
  }
}
