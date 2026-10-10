// tests/unit/lap-identity.test.ts — the owner key and the handle, on one device. DEV-373.
//
// Wrapped as `personal-best.ts` is, and held to the same cases its tests hold:
// a store that throws, a store that is full, garbage in the key. And held to
// the SERVER's shapes — `isHandle` and the owner key's 22-128 base64url — by
// the server's own code where it exports it, so a key minted here is a key the
// server takes.

import { describe, expect, it } from 'vitest'
import {
  cryptoRandomBytes,
  cryptoRandomInt,
  HANDLE_STORE,
  isOwnerKey,
  newOwnerKey,
  OWNER_KEY_STORE,
  ownerKey,
  readHandle,
  rerollHandle,
  saveHandle,
} from '@/game/lap-identity'
import { HANDLE_ADJECTIVES, HANDLE_NOUNS, isHandle } from '@/net/handles'

const memory = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}
const throwing = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('SecurityError')
  },
}
const full = (inner = memory()) => ({
  getItem: inner.getItem,
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
})
/** Counting bytes, so two keys from it differ and a test can say which it got. */
const counter = () => {
  let n = 0
  return (len: number) => Uint8Array.from({ length: len }, () => n++ & 0xff)
}

describe('the owner key', () => {
  it('is 16 random bytes as 22 base64url characters: the server’s floor', () => {
    const key = newOwnerKey(cryptoRandomBytes)
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(isOwnerKey(key)).toBe(true)
    expect(newOwnerKey(cryptoRandomBytes)).not.toBe(key)
  })

  it('is minted once and kept: the second call reads the first key', () => {
    const store = memory()
    const random = counter()
    const first = ownerKey(random, store)
    expect(store.map.get(OWNER_KEY_STORE)).toBe(first)
    expect(ownerKey(random, store)).toBe(first)
  })

  it('reads a key that is not the server’s shape as absent, and replaces it', () => {
    const store = memory()
    for (const junk of ['', 'short', 'x'.repeat(200), 'has spaces in it for sure!!', '{"a":1}']) {
      store.map.set(OWNER_KEY_STORE, junk)
      const key = ownerKey(counter(), store)
      expect(isOwnerKey(key), junk).toBe(true)
      expect(key).not.toBe(junk)
      expect(store.map.get(OWNER_KEY_STORE)).toBe(key)
    }
  })

  it('never throws: a blocked store and a full one still yield a key for the page', () => {
    expect(isOwnerKey(ownerKey(counter(), throwing))).toBe(true)
    expect(isOwnerKey(ownerKey(counter(), full()))).toBe(true)
    expect(isOwnerKey(ownerKey(counter(), null))).toBe(true)
  })
})

describe('the handle', () => {
  it('is kept only if the lists could have made it', () => {
    const store = memory()
    expect(readHandle(store)).toBeNull()
    expect(saveHandle('Swift Kestrel 42', store)).toBe(true)
    expect(readHandle(store)).toBe('Swift Kestrel 42')
    // Free text is refused on the way in, and read as absent on the way out.
    expect(saveHandle('xX_slur_Xx', store)).toBe(false)
    store.map.set(HANDLE_STORE, 'Hand Edited 12')
    expect(readHandle(store)).toBeNull()
  })

  it('never throws', () => {
    expect(readHandle(throwing)).toBeNull()
    expect(saveHandle('Swift Kestrel 42', throwing)).toBe(false)
    expect(saveHandle('Swift Kestrel 42', full())).toBe(false)
  })

  it('rerolls to another name the server will take, never the one on screen', () => {
    // A source that would hand back the same draw first: the reroll must move off it.
    let calls = 0
    const sticky = (n: number) => (calls++ < 3 ? 0 : Math.min(n - 1, 5))
    const current = `${HANDLE_ADJECTIVES[0]} ${HANDLE_NOUNS[0]} 10`
    const next = rerollHandle(current, sticky)
    expect(next).not.toBe(current)
    expect(isHandle(next)).toBe(true)
    for (let i = 0; i < 50; i++) expect(isHandle(rerollHandle(null, cryptoRandomInt))).toBe(true)
  })

  it('draws uniform integers in range from crypto', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const v = cryptoRandomInt(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
      seen.add(v)
    }
    expect(seen.size).toBe(7)
    expect(cryptoRandomInt(1)).toBe(0)
  })
})
