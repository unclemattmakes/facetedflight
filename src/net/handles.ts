// src/net/handles.ts — the names a lap is posted under. DEV-372.
//
// PLAYER-GHOSTS §8 call 4: a GENERATED handle with a reroll, not free text.
// Typing in a headset is poor, and it closes D30's *"slur in slot two"* risk by
// construction rather than by a blocklist that is always one word behind:
// there is no string the server will store that is not on these two lists.
//
// A handle is `<Adjective> <Noun> <NN>`, NN from 10 to 99: tens of thousands of
// them. Flight and weather words, chosen so that no pairing reads as anything
// but a call sign. Adding a word is safe; REMOVING one orphans every lap posted under it
// (the server would refuse to re-store it, and nothing else changes), so the
// lists only grow.
//
// Shared by the client (DEV-373's picker calls `randomHandle`) and the server
// (`isHandle`). SERVER-SAFE: no imports.

export const HANDLE_ADJECTIVES = [
  'Amber',
  'Azure',
  'Bold',
  'Brave',
  'Bright',
  'Calm',
  'Cobalt',
  'Coral',
  'Crimson',
  'Deft',
  'Eager',
  'Emerald',
  'Fleet',
  'Golden',
  'Hardy',
  'Indigo',
  'Ivory',
  'Jade',
  'Keen',
  'Lucky',
  'Lunar',
  'Nimble',
  'Noble',
  'Quick',
  'Rapid',
  'Silver',
  'Solar',
  'Steady',
  'Swift',
  'Teal',
  'Violet',
  'Windy',
] as const

export const HANDLE_NOUNS = [
  'Albatross',
  'Comet',
  'Condor',
  'Falcon',
  'Finch',
  'Gannet',
  'Glider',
  'Harrier',
  'Hawk',
  'Heron',
  'Kestrel',
  'Kite',
  'Lark',
  'Merlin',
  'Meteor',
  'Nova',
  'Osprey',
  'Pelican',
  'Petrel',
  'Pilot',
  'Plover',
  'Raven',
  'Robin',
  'Rocket',
  'Sparrow',
  'Starling',
  'Swallow',
  'Tern',
  'Voyager',
  'Wren',
  'Zephyr',
  'Skylark',
] as const

const ADJECTIVES: ReadonlySet<string> = new Set(HANDLE_ADJECTIVES)
const NOUNS: ReadonlySet<string> = new Set(HANDLE_NOUNS)
const SHAPE = /^([A-Z][a-z]+) ([A-Z][a-z]+) ([1-9][0-9])$/

/** Is this a handle the lists could have generated? The server's only test of a name. */
export const isHandle = (text: unknown): text is string => {
  if (typeof text !== 'string') return false
  const m = SHAPE.exec(text)
  return m !== null && ADJECTIVES.has(m[1] as string) && NOUNS.has(m[2] as string)
}

/**
 * A handle from a source of uniform integers in `[0, n)` — the caller's
 * randomness, so the picker can reroll and a test can be exact.
 */
export const randomHandle = (randomInt: (n: number) => number): string =>
  `${HANDLE_ADJECTIVES[randomInt(HANDLE_ADJECTIVES.length)]} ${HANDLE_NOUNS[randomInt(HANDLE_NOUNS.length)]} ${10 + randomInt(90)}`
