// src/net/tv-anon.ts — what a TV viewer is sent instead of a room's names. DEV-479.
//
// plan/FF-TV.md §2.3, Matt 2026-09-28: *"no room code and no identifying
// names"*. The broadcaster (`room-broadcast.ts`) sends a socket that came
// through TV — `TV_WATCH_PATH`, which only the TV Function's forward reaches —
// this copy of every text item, made ONCE per item however many TV viewers
// there are. Binary pose batches carry no names and go to everyone unchanged.
//
// What carries a name today: a `RoomPlayerView.handle`, in `keyframe.players`,
// `player-joined.player` and `lobby.players`. Nothing else on the feed is
// free text (§2.3's table). This does not rely on that list: it walks the
// whole message and replaces EVERY string under a key named `handle`, wherever
// it sits, so a message type added later that carries a player's view is
// anonymised the day it is written. The name is *Racer N*, N the seat's slot
// plus one — the words `game/room-names.ts`'s `racerName` draws for a name off
// the list, which `tests/unit/tv-anon.test.ts` holds equal. A handle whose
// slot cannot be read from where it sits becomes plain *Racer*.
//
// Never on the client: a TV client that received handles and hid them would
// leave them one dev-tools panel away. `tests/unit/tv-broadcast.test.ts`
// sweeps the BYTES fifty TV viewers receive.
//
// SERVER-SAFE and pure.

/** What TV calls the racer in `slot`. */
export const tvRacerName = (slot: number): string => `Racer ${slot + 1}`

/** A slot as a record key or field carries it, or null. */
const slotOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1000 ? n : null
}

/**
 * Every `handle` under `v` replaced, in a copy. `slot` is the seat the object
 * being walked belongs to, as far as is known: a players map's key, or the
 * `slot` field of the message holding a `player`.
 */
const strip = (v: unknown, slot: number | null): unknown => {
  if (Array.isArray(v)) return v.map((x) => strip(x, null))
  if (typeof v !== 'object' || v === null) return v
  const o = v as Record<string, unknown>
  const own = slotOf(o.slot) ?? slot
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) {
    if (k === 'handle' && typeof x === 'string') {
      out[k] = own === null ? 'Racer' : tvRacerName(own)
    } else if (k === 'players' && typeof x === 'object' && x !== null && !Array.isArray(x)) {
      const players: Record<string, unknown> = {}
      for (const [s, p] of Object.entries(x as Record<string, unknown>)) {
        players[s] = strip(p, slotOf(s))
      }
      out[k] = players
    } else if (k === 'player') {
      out[k] = strip(x, own)
    } else {
      out[k] = strip(x, null)
    }
  }
  return out
}

/** A message with every handle replaced by *Racer N*. */
export const anonymise = <T>(message: T): T => strip(message, null) as T

/**
 * One text item as a TV viewer receives it. Text that is not JSON (the
 * keep-alive's answer) carries no name and passes unchanged; text that names
 * nobody is returned as it came, byte for byte.
 */
export const anonymiseText = (text: string): string => {
  if (!text.includes('"handle"')) return text
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    // Not JSON, and it says "handle": send nothing a name could be in.
    return '{}'
  }
  return JSON.stringify(anonymise(msg))
}
