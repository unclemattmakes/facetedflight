// src/content/callsigns.ts: the AI racers' callsigns. DEV-651.
//
// The board used to read `fast`, `steady`, `cutter`, `wide`, `cruiser`: the
// tuning ids from `sim/ai-racer.ts`, which on a broadcast read as debug output
// (CONSULTANT-REVIEW-2026-10-05 §4). Matt gave thirteen names
// (`content/callsigns.json`, verbatim) and said each race draws its racers'
// from the pool.
//
// ── The one rule: a callsign is a function of the RACE, never of the machine ─
//
// A TV viewer, a room's members and a replay must read the same names for the
// same race, so a draw takes the race's own seed and nothing else: no
// `Math.random`, no clock, no per-load salt. The seed is an FNV-1a hash of what
// identifies the race (`callsignSeed`): for single player and the TV
// exhibition the course, for a room the frozen race (its course, starts, bots
// and colours: what every client already holds and the host flies its bots
// from). The draw is a seeded Fisher-Yates shuffle of the pool, taken from the
// front, so **no name stands twice in one race** by construction.
//
// A tuning id stays the racer's IDENTITY (`spec.id`: the engine map, the mesh's
// name `racer:<id>`, the contact log all key on it). A callsign is how it is
// CALLED: `spec.callsign`, shown on the TV board, the results board, a room's
// bot tag.
//
// Pure: no three, no DOM.

import { fnv1a32 } from '@/sim/math/hash'
import { mulberry32 } from '@/sim/math/rng'
// The attribute is for Node's own loader, which Playwright's collection uses for every
// src/ module a spec reaches (`render/tv-panel-layout.ts` imports this): without it
// the whole e2e collection dies on 'needs an import attribute of type: json'.
import pool from '../../content/callsigns.json' with { type: 'json' }

/** The pool as Matt wrote it, in file order. Validated at load: a bad file throws. */
export const CALLSIGNS: readonly string[] = ((): readonly string[] => {
  const list: unknown = pool.callsigns
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('content/callsigns.json: "callsigns" must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const name of list as unknown[]) {
    if (typeof name !== 'string' || name.trim() !== name || name.length === 0) {
      throw new Error(
        `content/callsigns.json: ${JSON.stringify(name)} is not a trimmed non-empty string`,
      )
    }
    const key = name.toLowerCase()
    if (seen.has(key)) throw new Error(`content/callsigns.json: "${name}" is listed twice`)
    seen.add(key)
  }
  return list as string[]
})()

/** Separates the parts of a seed so `('a', 'bc')` and `('ab', 'c')` hash apart. */
const SEED_SEPARATOR = '\u001f'

/**
 * The seed of one race, from whatever names it: the same parts give the same
 * seed on every machine and load. Numbers and strings only, in a fixed order.
 */
export const callsignSeed = (...parts: readonly (string | number)[]): number =>
  fnv1a32(parts.map(String).join(SEED_SEPARATOR))

/**
 * `count` callsigns for one race, in racer order, drawn from `names` (the pool
 * by default) off `seed`. Distinct while the pool lasts; past it a name
 * comes round again with a number (`stan 2`), so a crowded room still reads as
 * names rather than failing.
 */
export const drawCallsigns = (
  seed: number,
  count: number,
  names: readonly string[] = CALLSIGNS,
): string[] => {
  const order = [...names]
  const random = mulberry32(seed)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const t = order[i] as string
    order[i] = order[j] as string
    order[j] = t
  }
  const out: string[] = []
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const lap = Math.floor(i / order.length)
    const name = order[i % order.length] as string
    out.push(lap === 0 ? name : `${name} ${lap + 1}`)
  }
  return out
}

/** Is `name` one a draw can make (a pool name, or one numbered past the pool)? */
export const isCallsign = (name: string): boolean => {
  const base = name.replace(/ [2-9][0-9]?$/, '')
  return CALLSIGNS.includes(base)
}

/**
 * How a callsign is SHOWN: upper case (`LIL BITEY`), the broadcast convention
 * the results panel already uses for every name. The pool keeps Matt's words;
 * painters call this.
 */
export const callsignDisplay = (name: string): string => name.toUpperCase()
