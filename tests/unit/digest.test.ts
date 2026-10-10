// tests/unit/digest.test.ts: the one async SHA-256 (code-reuse audit BE-3).
//
// The lap server STORES `sha256HexAsync` outputs (owner hash, address hash):
// a change of encoding or case would orphan every one. Known vectors, from
// FIPS 180-2 and checked against node's own `crypto`, pin the bytes; the sync
// implementation in `content/sha256.ts` is the second witness.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex as syncSha256Hex } from '@/content/sha256'
import { hexOfBytes, sha256Bytes, sha256HexAsync } from '@/net/digest'

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('sha256HexAsync', () => {
  it('matches the FIPS vectors, lower-case, 64 characters', async () => {
    expect(await sha256HexAsync('abc')).toBe(ABC)
    expect(await sha256HexAsync('')).toBe(EMPTY)
  })

  it('hashes a string as UTF-8 and bytes as themselves: both agree with node and the sync one', async () => {
    const text = 'owner-é€ 🛩'
    const bytes = new TextEncoder().encode(text)
    const want = createHash('sha256').update(text, 'utf8').digest('hex')
    expect(await sha256HexAsync(text)).toBe(want)
    expect(await sha256HexAsync(bytes)).toBe(want)
    expect(syncSha256Hex(bytes)).toBe(want)
  })

  it('is not disturbed by a view into a bigger buffer', async () => {
    const big = new Uint8Array([9, 9, 97, 98, 99, 9])
    expect(await sha256HexAsync(big.subarray(2, 5))).toBe(ABC)
  })
})

describe('sha256Bytes and hexOfBytes', () => {
  it('are 32 bytes, and hex pads each to two digits', async () => {
    const d = await sha256Bytes('abc')
    expect(d).toHaveLength(32)
    expect(hexOfBytes(d)).toBe(ABC)
    expect(hexOfBytes(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
    // The stats server keeps the first eight bytes: sixteen hex characters.
    expect(hexOfBytes(d.slice(0, 8))).toBe(ABC.slice(0, 16))
  })
})
