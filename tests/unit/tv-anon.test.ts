// tests/unit/tv-anon.test.ts — what a TV viewer is sent instead of a name. DEV-479.
//
// `src/net/tv-anon.ts`: every `handle`, wherever it sits, becomes *Racer N*
// (plan/FF-TV.md §2.3). The words are the ones a client draws for a name off
// the list (`game/room-names.ts`'s `racerName`, DEV-485), held equal here
// because the Functions bundle may not import the game.

import { describe, expect, it } from 'vitest'
import { racerName } from '@/game/room-names'
import type { KeyframeMessage, ServerMessage } from '@/net/room-protocol'
import { anonymise, anonymiseText, tvRacerName } from '@/net/tv-anon'

const view = (handle: string) => ({
  handle,
  variant: 'standard',
  colour: 1,
  ready: true,
  joinSeq: 0,
  present: true,
})

describe('anonymise (§2.3)', () => {
  it('says Racer N as the game draws a name off the list', () => {
    for (let slot = 0; slot < 16; slot++) expect(tvRacerName(slot)).toBe(racerName(slot))
  })

  it('replaces every handle in a keyframe, a lobby and a player-joined by its slot', () => {
    const keyframe = {
      type: 'keyframe',
      players: { 0: view('Swift Kestrel 42'), 3: view('Calm Heron 17') },
      results: [{ slot: 3, verdict: 'ok' }],
    } as unknown as KeyframeMessage
    const k = anonymise(keyframe)
    expect(k.players[0]?.handle).toBe('Racer 1')
    expect(k.players[3]?.handle).toBe('Racer 4')
    expect(k.players[3]?.colour).toBe(1)
    expect(k.results).toEqual(keyframe.results)
    // The original is not touched: the link viewers' copy is the room's own text.
    expect(keyframe.players[0]?.handle).toBe('Swift Kestrel 42')

    const joined = {
      type: 'player-joined',
      slot: 2,
      player: view('Bold Falcon 19'),
      owner: 0,
    } as ServerMessage
    expect(JSON.stringify(anonymise(joined))).toBe(
      JSON.stringify({ ...joined, player: { ...view('Racer 3') } }),
    )

    const lobby = {
      type: 'lobby',
      owner: 0,
      settings: null,
      players: { 5: view('Amber Osprey 88') },
    }
    expect(anonymise(lobby).players[5]?.handle).toBe('Racer 6')
  })

  it('catches a handle in a message type it has never seen', () => {
    const later = { type: 'roster', seats: [{ slot: 1, who: { handle: 'Swift Kestrel 42' } }] }
    expect(JSON.stringify(anonymise(later))).not.toContain('Kestrel')
  })

  it('passes text that names nobody byte for byte, and sends nothing for unreadable text that might', () => {
    const ring = '{"type":"ring","gate":3,"tick":400,"slot":1}'
    expect(anonymiseText(ring)).toBe(ring)
    expect(anonymiseText('ka!')).toBe('ka!')
    expect(anonymiseText('{"handle":"Swift Kestrel 42"')).toBe('{}')
  })
})
