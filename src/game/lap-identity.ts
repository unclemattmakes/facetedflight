// src/game/lap-identity.ts — who posts a shared lap, on this device. DEV-373.
//
// PLAYER-GHOSTS §8 call 4 and §5: a player is a HANDLE from a generated list
// (`net/handles.ts`, with a reroll) and a per-device OWNER KEY — random, made
// here, kept here, sent with each lap so that device can delete it again
// (`DELETE /api/laps?id=`, the key in `X-FF-Owner`). The server stores only
// the key's SHA-256 and never another string as a name. There is no account.
//
// ── Wrapped exactly as `personal-best.ts` is, and for its reasons ────────
//
// `localStorage` THROWS on access in a private window with site data blocked
// and in some webviews, so every read and write is inside a try and the storage
// is injectable. What is read back is checked before it is believed: a handle
// the lists could not have generated, or a key that is not the shape the server
// takes, is ABSENT, and the next call makes a fresh one. A store that cannot be
// written still yields a key and a handle for THIS page: the lap is posted, and
// only the memory of who posted it is lost (so that device cannot delete it
// later — which is exactly what a private window promises).
//
// Randomness is the caller's (`crypto.getRandomValues` in the app), so a test
// can be exact.

import { toBase64url } from '@/net/base64url'
import { isHandle, randomHandle } from '@/net/handles'
import { safeStorage } from './personal-best'

type IdentityStorage = Pick<Storage, 'getItem' | 'setItem'>

/** `.v1` is the store's format, as `bestKey`'s is. */
export const OWNER_KEY_STORE = 'ff2.owner.v1'
export const HANDLE_STORE = 'ff2.handle.v1'

/**
 * Random bytes in a key: 16 is 128 bits, 22 base64url characters — the
 * server's floor (`OWNER_SHAPE` in `net/lap-server.ts`, 22 to 128).
 */
export const OWNER_KEY_BYTES = 16

/** The server's shape for an owner key, so nothing unsendable is kept. */
const OWNER_SHAPE = /^[A-Za-z0-9_-]{22,128}$/

export const isOwnerKey = (text: unknown): text is string =>
  typeof text === 'string' && OWNER_SHAPE.test(text)

/** A fresh key from `randomBytes`. */
export const newOwnerKey = (randomBytes: (n: number) => Uint8Array): string =>
  toBase64url(randomBytes(OWNER_KEY_BYTES))

/**
 * This device's owner key: the kept one, or a fresh one kept now. Never throws.
 * A store that cannot be written still gets a key; the caller holds it for the
 * page's life, so every lap from this page is one owner's.
 */
export const ownerKey = (
  randomBytes: (n: number) => Uint8Array,
  storage: IdentityStorage | null = safeStorage(),
): string => {
  try {
    const kept = storage?.getItem(OWNER_KEY_STORE) ?? null
    if (isOwnerKey(kept)) return kept
  } catch {
    // Read below as absent.
  }
  const key = newOwnerKey(randomBytes)
  try {
    storage?.setItem(OWNER_KEY_STORE, key)
  } catch {
    // Quota, a private window: this page's laps are one owner's, and that is all.
  }
  return key
}

/** The handle this device last posted under, or null. Never throws. */
export const readHandle = (storage: IdentityStorage | null = safeStorage()): string | null => {
  try {
    const kept = storage?.getItem(HANDLE_STORE) ?? null
    return isHandle(kept) ? kept : null
  } catch {
    return null
  }
}

/** Keep the handle a lap was posted under, so the next Share offers it first. */
export const saveHandle = (
  handle: string,
  storage: IdentityStorage | null = safeStorage(),
): boolean => {
  if (!isHandle(handle) || !storage) return false
  try {
    storage.setItem(HANDLE_STORE, handle)
    return true
  } catch {
    return false
  }
}

/**
 * Another handle, never the one on screen: a reroll that could land on the
 * same name would read as a press that did nothing. Tens of thousands of
 * handles, so the loop ends on its first or second draw.
 */
export const rerollHandle = (current: string | null, randomInt: (n: number) => number): string => {
  for (let i = 0; i < 16; i++) {
    const next = randomHandle(randomInt)
    if (next !== current) return next
  }
  return randomHandle(randomInt)
}

/** `crypto.getRandomValues`, as the two sources above take it. */
export const cryptoRandomBytes = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n))

/** A uniform integer in `[0, n)` from `crypto`, unbiased by rejection. */
export const cryptoRandomInt = (n: number): number => {
  if (n <= 1) return 0
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(buf)
    const v = buf[0] as number
    if (v < limit) return v % n
  }
}
