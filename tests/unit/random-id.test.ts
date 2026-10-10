// tests/unit/random-id.test.ts: the one unbiased id loop (code-reuse audit
// BE-10). Randomness is injected, so the rejection rule is testable exactly.

import { describe, expect, it } from 'vitest'
import { LAP_ID_LENGTH } from '@/net/lap-policy'
import { newLapId } from '@/net/lap-server'
import { cryptoFill, type FillRandom, randomIdOver } from '@/net/random-id'
import { STATS_BUG_ID_ALPHABET, STATS_BUG_ID_LENGTH } from '@/net/stats-schema'
import { newBugId } from '@/net/stats-server'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** A source that hands out `values` in order, then repeats the last. */
const fixed = (values: readonly number[]): FillRandom => {
  let at = 0
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = values[Math.min(at++, values.length - 1)] ?? 0
  }
}

describe('randomIdOver', () => {
  it('maps a byte to alphabet[byte % n] below the ceiling', () => {
    // 62 -> ceiling 248: bytes 0, 61, 62, 247 are 0, z, 0, then 247 % 62 = 61.
    expect(randomIdOver(BASE62, 4, fixed([0, 61, 62, 247]))).toBe('0z0z')
  })

  it('rerolls a byte at or past the ceiling instead of folding it', () => {
    // 248..255 would favour the low characters of the alphabet if folded.
    expect(randomIdOver(BASE62, 3, fixed([248, 255, 250, 1, 2, 3]))).toBe('123')
    const abc = 'abc'
    // 3 -> ceiling 255: only 255 is refused.
    expect(randomIdOver(abc, 3, fixed([255, 0, 1, 2]))).toBe('abc')
  })

  it('draws again until it has `length` characters, however many it throws away', () => {
    let draws = 0
    const stingy: FillRandom = (bytes) => {
      draws++
      bytes.fill(255)
      if (draws === 5) bytes.fill(7)
    }
    expect(randomIdOver(BASE62, 5, stingy)).toBe('77777')
    expect(draws).toBe(5)
  })

  it('every character of the alphabet is reachable and each equally often over all kept bytes', () => {
    const counts = new Map<string, number>()
    for (let b = 0; b < 248; b++) {
      const c = randomIdOver(BASE62, 1, fixed([b]))
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    expect(counts.size).toBe(62)
    expect(new Set(counts.values())).toEqual(new Set([4]))
  })
})

describe('the two ids built on it', () => {
  it('a lap id is LAP_ID_LENGTH base62 characters, and fresh each time', () => {
    const a = newLapId()
    expect(a).toMatch(new RegExp(`^[0-9A-Za-z]{${LAP_ID_LENGTH}}$`))
    expect(newLapId()).not.toBe(a)
  })

  it('a bug id is STATS_BUG_ID_LENGTH characters of its own alphabet', () => {
    expect(newBugId()).toMatch(new RegExp(`^[${STATS_BUG_ID_ALPHABET}]{${STATS_BUG_ID_LENGTH}}$`))
  })

  it('cryptoFill fills the whole buffer from the platform', () => {
    const bytes = new Uint8Array(64)
    cryptoFill(bytes)
    expect(bytes.some((b) => b !== 0)).toBe(true)
  })
})
